import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const migrationsDir =
  process.env.MIGRATIONS_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations')
const db = new PGlite()

await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create or replace function auth.role() returns text language sql stable as $$
    select case when auth.uid() is null then 'anon' else 'authenticated' end
  $$;
  grant usage on schema auth to authenticated;
  grant execute on function auth.uid() to authenticated;
  grant execute on function auth.role() to authenticated;
  create schema storage;
  create table storage.buckets (
    id text primary key, name text not null, public boolean not null default false,
    file_size_limit bigint, allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets(id), name text not null, owner uuid,
    metadata jsonb
  );
  grant usage on schema storage to authenticated;
  grant select, insert, update, delete on table storage.objects to authenticated;
  alter table storage.objects enable row level security;
  create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$
    select case
      when array_length(string_to_array(name, '/'), 1) > 1
      then (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
      else array[]::text[]
    end
  $$;
  create or replace function public.uuid_generate_v4() returns uuid
  language sql volatile as $$ select gen_random_uuid() $$;
  create schema extensions;
  grant usage on schema extensions to anon, authenticated, service_role;
  create or replace function extensions.digest(p_data text, p_algo text) returns bytea
  language sql immutable as $$
    select case
      when p_algo = 'sha256' then sha256(convert_to(p_data, 'UTF8'))
      when p_algo = 'sha512' then sha512(convert_to(p_data, 'UTF8'))
      else null
    end
  $$;
`)

const files = (await readdir(migrationsDir)).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()
for (const file of files) {
  let sql = await readFile(join(migrationsDir, file), 'utf8')
  sql = sql.replace(/^create extension[^;]+;\s*$/gim, '')
  sql = sql.replace(/create index[^;]*gin_trgm_ops[^;]*;/gis, '')
  await db.exec(sql)
}
console.log(`APPLY PASS ${files.length} migrations`)

await db.exec(`
  grant usage on schema public to anon, authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant usage, select on all sequences in schema public to authenticated;
`)

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`)
  console.log(`PASS ${message}`)
}

async function expectReject(label, operation, expectedMessage) {
  try {
    await operation()
  } catch (error) {
    if (expectedMessage && !String(error).includes(expectedMessage)) {
      throw new Error(`FAIL ${label}: wrong error: ${error}`)
    }
    console.log(`PASS ${label}`)
    return
  }
  throw new Error(`FAIL ${label}: unexpectedly allowed`)
}

async function scalar(sql) {
  const result = await db.query(sql)
  return result.rows[0] ? Object.values(result.rows[0])[0] : null
}

async function rows(sql) {
  return (await db.query(sql)).rows
}

async function setUser(userId) {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', '${userId}', false)`)
  await db.exec('set role authenticated')
}

async function asSuper() {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub', '', false)")
}

const num = (value) => (value === null || value === undefined ? null : Number(value))

assert(
  files.includes('0047_business_order_item_payment_allocations.sql'),
  '0047 is included in the replay chain',
)
assert(
  files.includes('0048_exempt_adjust_items_from_daily_field_lock.sql'),
  '0048 (later adjust redefinition) is also replayed on top of 0047',
)

// --- 结构校验：allocation_target / order_item_id / 约束 / 索引 ---
assert(
  (await scalar(
    `select count(*)::int from information_schema.columns
     where table_schema='public' and table_name='business_order_payment_allocations'
       and column_name='allocation_target' and data_type='text' and is_nullable='NO'`,
  )) === 1,
  'allocation_target is a NOT NULL text column',
)
assert(
  String(
    await scalar(
      `select column_default from information_schema.columns
       where table_schema='public' and table_name='business_order_payment_allocations'
         and column_name='allocation_target'`,
    ),
  ).includes('order'),
  'allocation_target defaults to order for legacy callers',
)
assert(
  (await scalar(
    `select count(*)::int from information_schema.table_constraints
     where constraint_schema='public' and table_name='business_order_payment_allocations'
       and constraint_name='business_order_payment_allocations_target_check'`,
  )) === 1,
  'allocation_target check constraint exists',
)
assert(
  (await scalar(
    `select count(*)::int from pg_constraint c
     where c.contype='f'
       and c.conrelid='public.business_order_payment_allocations'::regclass
       and c.confrelid='public.business_order_items'::regclass`,
  )) === 1,
  'order_item_id has a foreign key to business_order_items',
)
assert(
  (await scalar(
    `select count(*)::int from pg_indexes
     where schemaname='public'
       and indexname='business_order_payment_allocations_active_item_idx'`,
  )) === 1,
  'active item allocation partial index exists',
)

// --- 基础数据 ---
const admin = '11111111-1111-4111-8111-111111111111'
const finance = '22222222-2222-4222-8222-222222222222'
const sales = '33333333-3333-4333-8333-333333333333'
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const customerId = '55555555-5555-4555-8555-555555555555'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values
    ('${admin}', 'admin@example.com'),
    ('${finance}', 'finance@example.com'),
    ('${sales}', 'sales@example.com');
  update public.profiles set role='admin', status='approved', full_name='Admin' where id='${admin}';
  update public.profiles set role='finance', status='approved', full_name='Finance' where id='${finance}';
  update public.profiles set role='sales', status='approved', full_name='Sales' where id='${sales}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  insert into public.products (id, sku, name) values ('${productId}', 'SKU-0047', '0047 Product');
  insert into public.customers (id, name, created_by)
    values ('${customerId}', '0047 Customer', '${sales}');
`)

await setUser(finance)
const shopId = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0047 USD Shop', null, true,
    array['${admin}','${sales}']::uuid[], 'USD'::public.currency_code)
`)
assert(!!shopId, 'finance seeds a shop for the rehearsal')

function item(qty, unitPrice, received) {
  return {
    product_id: productId,
    quantity: qty,
    unit_price: unitPrice,
    daily_shipping_category: 'stock',
    product_received_amount: received,
    product_received_overridden: true,
    logistics_fee_amount: 0,
    sales_total_amount: received,
    sales_total_overridden: true,
  }
}

async function createOrder({ label, itemsJson, shippingFee, customerId: cid }) {
  const [productTotal, shippingTotal, salesTotal] = JSON.parse(itemsJson).reduce(
    (acc, it) => [
      acc[0] + it.product_received_amount,
      acc[1] + it.logistics_fee_amount,
      acc[2] + it.sales_total_amount,
    ],
    [0, 0, 0],
  )
  await setUser(admin)
  const result = await db.query(`
    select * from public.create_business_order_v4(
      ${cid ? `'${cid}'` : 'null'}, current_date, 'stock'::public.business_fulfillment_type,
      'USD'::public.currency_code, 7.2, ${shippingFee}, null, null,
      '${itemsJson}'::jsonb, null, '${shopId}', '${sales}', '0047-${label}',
      current_date, 'SHIP-${label}', 'full'::public.daily_order_payment_category,
      ${productTotal}, false, ${shippingTotal}, false, ${salesTotal}, false,
      'partial prepayment recorded at order creation', null)
  `)
  return result.rows[0].id
}

async function orderItems(orderId) {
  return rows(`
    select id::text, origin, line_amount::numeric, product_received_amount::numeric
    from public.business_order_items where order_id='${orderId}'
    order by sort_order
  `)
}

// TARGET 复刻生产 BO-2026-0006：3 行产品（收 800 / 收 1100 / 收 0）+ 运费 300。
const targetOrder = await createOrder({
  label: 'TARGET',
  itemsJson: JSON.stringify([item(8, 100, 800), item(22, 100, 1100), item(9, 1, 0)]),
  shippingFee: 300,
})
const targetItems = await orderItems(targetOrder)
assert(targetItems.length === 3, 'target order has three item rows')

// OTHER：2 行产品（收 40 / 收 50）+ 运费 60。
const otherOrder = await createOrder({
  label: 'OTHER',
  itemsJson: JSON.stringify([item(2, 100, 40), item(3, 50, 50)]),
  shippingFee: 60,
})
const otherItems = await orderItems(otherOrder)
assert(otherItems.length === 2, 'other order has two item rows')

// 客户订单：1 行产品（收 100）+ 运费 50。
const customerOrder = await createOrder({
  label: 'CUST',
  itemsJson: JSON.stringify([item(2, 100, 100)]),
  shippingFee: 50,
  customerId,
})
const customerItems = await orderItems(customerOrder)
assert(customerItems.length === 1, 'customer order has one item row')

async function orderState(orderId) {
  return (
    await rows(`select status::text st, payment_status::text ps,
                       items_subtotal::numeric sub, total_amount::numeric tot,
                       total_product_received_amount::numeric pr,
                       total_shipping_received_amount::numeric sr,
                       total_sales_amount::numeric sa
                from public.business_orders where id='${orderId}'`)
  )[0]
}

const initialTarget = await orderState(targetOrder)
assert(
  initialTarget.st === 'approved' &&
    num(initialTarget.sub) === 3009 &&
    num(initialTarget.tot) === 3309 &&
    num(initialTarget.pr) === 1900 &&
    num(initialTarget.sr) === 0 &&
    num(initialTarget.sa) === 1900 &&
    initialTarget.ps === 'partially_paid',
  'target order starts approved 3009/3309 with received 1900 and partially_paid status',
)

async function seedOrderProof(orderId) {
  await asSuper()
  const path = `${sales}/order/${orderId}/${randomUUID()}.jpg`
  await db.exec(`
    insert into storage.objects(bucket_id, name, owner, metadata)
    values ('business-payment-proofs', '${path}', '${sales}',
            '{"mimetype":"image/jpeg","size":"1024"}'::jsonb)
  `)
  return path
}

async function seedCustomerProof() {
  await asSuper()
  const path = `${sales}/customer/${customerId}/${randomUUID()}.jpg`
  await db.exec(`
    insert into storage.objects(bucket_id, name, owner, metadata)
    values ('business-payment-proofs', '${path}', '${sales}',
            '{"mimetype":"image/jpeg","size":"1024"}'::jsonb)
  `)
  return path
}

async function recordTransfer({ customerId: cid, orderId, amount, allocations, key, proof }) {
  await setUser(sales)
  return db.query(`
    select public.record_business_customer_transfer_v2(
      ${cid ? `'${cid}'` : 'null'}, ${orderId ? `'${orderId}'` : 'null'},
      'USD'::public.currency_code, ${amount}, 7.2, '2026-09-15T12:00:00Z'::timestamptz,
      'balance'::public.business_payment_type, '${proof}', null, null,
      '${key}', '${JSON.stringify(allocations)}'::jsonb)
  `)
}

const allocItem = (orderId, itemId, amount) => ({
  order_id: orderId,
  order_item_id: itemId,
  allocation_target: 'item',
  amount,
})
const allocShipping = (orderId, amount) => ({
  order_id: orderId,
  allocation_target: 'shipping',
  amount,
})
const allocOrder = (orderId, amount) => ({ order_id: orderId, amount })

// --- 场景 1：订单转账按 产品行 + 运费行 分摊到全额 ---
const targetProof = await seedOrderProof(targetOrder)
await recordTransfer({
  orderId: targetOrder,
  amount: 1409,
  allocations: [
    allocItem(targetOrder, targetItems[1].id, 1100),
    allocItem(targetOrder, targetItems[2].id, 9),
    allocShipping(targetOrder, 300),
  ],
  key: 'IDEM-0047-OK',
  proof: targetProof,
})

const targetAllocs = await rows(`
  select order_item_id::text item_id, allocation_target target, a.amount::numeric amt
  from public.business_order_payment_allocations a
  join public.business_customer_transfers t on t.id = a.transfer_id
  where t.idempotency_key='IDEM-0047-OK'
  order by allocation_target, order_item_id nulls last
`)
assert(
  targetAllocs.length === 3 &&
    targetAllocs.some(
      (r) => r.target === 'item' && r.item_id === targetItems[1].id && num(r.amt) === 1100,
    ) &&
    targetAllocs.some(
      (r) => r.target === 'item' && r.item_id === targetItems[2].id && num(r.amt) === 9,
    ) &&
    targetAllocs.some((r) => r.target === 'shipping' && r.item_id === null && num(r.amt) === 300),
  'transfer allocates 1100 + 9 to item rows and 300 to shipping with explicit targets',
)
assert(
  !targetAllocs.some((r) => r.item_id === targetItems[0].id),
  'fully received item row receives no allocation',
)
assert(
  (await orderState(targetOrder)).ps === 'fully_paid',
  'order becomes fully_paid only when every item and shipping outstanding is covered',
)
await setUser(admin)
assert(
  num(
    (
      await rows(`select outstanding_amount::numeric from public.get_business_orders_outstanding_amount(
        array['${targetOrder}']::uuid[])`)
    )[0].outstanding_amount,
  ) === 0,
  'outstanding RPC reports zero after full item-and-shipping allocation',
)

// --- 场景 2：幂等回放（含新字段的原始 allocations 进哈希）---
await recordTransfer({
  orderId: targetOrder,
  amount: 1409,
  allocations: [
    allocItem(targetOrder, targetItems[1].id, 1100),
    allocItem(targetOrder, targetItems[2].id, 9),
    allocShipping(targetOrder, 300),
  ],
  key: 'IDEM-0047-OK',
  proof: targetProof,
})
assert(
  (await scalar(
    `select count(*)::int from public.business_customer_transfers
     where idempotency_key='IDEM-0047-OK'`,
  )) === 1,
  'replaying the identical item-and-shipping payload returns the stored idempotent result',
)
const tamperProof = await seedOrderProof(targetOrder)
await expectReject(
  'the same idempotency key with a different allocation payload is rejected',
  async () =>
    recordTransfer({
      orderId: targetOrder,
      amount: 1409,
      allocations: [
        allocItem(targetOrder, targetItems[1].id, 1000),
        allocItem(targetOrder, targetItems[2].id, 9),
        allocShipping(targetOrder, 400),
      ],
      key: 'IDEM-0047-OK',
      proof: tamperProof,
    }),
  'Idempotency key was already used with a different payload',
)

// --- 场景 3-9：逐项校验拒绝路径（全部应整体回滚）---
const otherD = otherItems[0].id
const otherE = otherItems[1].id

await expectReject(
  'batch total above order settlement outstanding is rejected',
  async () =>
    recordTransfer({
      orderId: otherOrder,
      amount: 500,
      allocations: [allocItem(otherOrder, otherD, 400), allocItem(otherOrder, otherE, 100)],
      key: 'IDEM-0047-BATCH',
      proof: await seedOrderProof(otherOrder),
    }),
  'Allocations exceed order outstanding amount',
)

await expectReject(
  'a single item allocation above its remaining outstanding is rejected',
  async () =>
    recordTransfer({
      orderId: otherOrder,
      amount: 200,
      allocations: [allocItem(otherOrder, otherD, 200)],
      key: 'IDEM-0047-ITEM',
      proof: await seedOrderProof(otherOrder),
    }),
  'Allocation exceeds order item outstanding amount',
)

await expectReject(
  'a shipping allocation above the shipping outstanding is rejected',
  async () =>
    recordTransfer({
      orderId: otherOrder,
      amount: 100,
      allocations: [allocShipping(otherOrder, 100)],
      key: 'IDEM-0047-SHIP',
      proof: await seedOrderProof(otherOrder),
    }),
  'Allocation exceeds order shipping outstanding amount',
)

await expectReject(
  'order-scoped transfers can no longer post a legacy order-level row',
  async () =>
    recordTransfer({
      orderId: otherOrder,
      amount: 60,
      allocations: [allocOrder(otherOrder, 60)],
      key: 'IDEM-0047-LEGACY',
      proof: await seedOrderProof(otherOrder),
    }),
  'Order transfer allocations must target an order item or shipping',
)

await expectReject(
  'an item id paired with the order target is rejected',
  async () =>
    recordTransfer({
      orderId: otherOrder,
      amount: 20,
      allocations: [
        { order_id: otherOrder, order_item_id: otherD, allocation_target: 'order', amount: 20 },
      ],
      key: 'IDEM-0047-BADTARGET',
      proof: await seedOrderProof(otherOrder),
    }),
  'Allocation target is invalid',
)

await expectReject(
  'two allocations targeting the same order item are rejected',
  async () =>
    recordTransfer({
      orderId: otherOrder,
      amount: 20,
      allocations: [allocItem(otherOrder, otherD, 10), allocItem(otherOrder, otherD, 10)],
      key: 'IDEM-0047-DUP',
      proof: await seedOrderProof(otherOrder),
    }),
  'Each allocation must target a unique order, order item, or shipping',
)

await expectReject(
  'an item id from another order is rejected',
  async () =>
    recordTransfer({
      orderId: otherOrder,
      amount: 10,
      allocations: [
        { order_id: otherOrder, order_item_id: targetItems[2].id, allocation_target: 'item', amount: 10 },
      ],
      key: 'IDEM-0047-FOREIGN-ITEM',
      proof: await seedOrderProof(otherOrder),
    }),
  'Allocation order item does not belong to allocation order',
)

assert(
  (await scalar(
    `select count(*)::int from public.business_customer_transfers
     where order_id='${otherOrder}'`,
  )) === 0,
  'every rejected order-scoped transfer rolls back completely',
)
assert(
  (await orderState(otherOrder)).ps === 'partially_paid',
  'other order stays partially_paid after rolled back attempts',
)
await setUser(admin)
assert(
  num(
    (
      await rows(`select outstanding_amount::numeric from public.get_business_orders_outstanding_amount(
        array['${otherOrder}']::uuid[])`)
    )[0].outstanding_amount,
  ) === 320,
  'other order still reports settlement outstanding 320 after rolled back attempts',
)

// --- 场景 10：客户作用域转账，明细行 + 兼容整单行 ---
const customerProof1 = await seedCustomerProof()
await recordTransfer({
  customerId,
  amount: 100,
  allocations: [allocItem(customerOrder, customerItems[0].id, 100)],
  key: 'IDEM-0047-CUST-ITEM',
  proof: customerProof1,
})
assert(
  (await orderState(customerOrder)).ps === 'partially_paid',
  'customer-scoped item allocation leaves the order partially_paid',
)
const customerProof2 = await seedCustomerProof()
await recordTransfer({
  customerId,
  amount: 50,
  allocations: [allocOrder(customerOrder, 50)],
  key: 'IDEM-0047-CUST-ORDER',
  proof: customerProof2,
})
const customerAllocs = await rows(`
  select order_item_id::text item_id, allocation_target target, a.amount::numeric amt
  from public.business_order_payment_allocations a
  join public.business_customer_transfers t on t.id = a.transfer_id
  where a.order_id='${customerOrder}'
  order by allocation_target
`)
assert(
  customerAllocs.length === 2 &&
    customerAllocs.some((r) => r.target === 'item' && num(r.amt) === 100) &&
    customerAllocs.some(
      (r) => r.target === 'order' && r.item_id === null && num(r.amt) === 50,
    ),
  'customer-scoped transfers accept both item rows and legacy order rows',
)
assert(
  (await orderState(customerOrder)).ps === 'fully_paid',
  'customer order becomes fully_paid once item and legacy rows cover the settlement gap',
)

// --- 场景 11：追加行分摊后禁止删除（含正向对照）---
async function adjust(orderId, items, key, actor = finance) {
  await setUser(actor)
  const expected = await scalar(
    `select version from public.business_orders where id='${orderId}'`,
  )
  return db.query(`
    select public.adjust_business_order_items(
      '${orderId}', ${expected}, '${JSON.stringify(items)}'::jsonb,
      'add_on', '0047 rehearsal', '${key}')
  `)
}

const appendItem = { ...item(1, 100, 0) }
await adjust(targetOrder, [appendItem], 'IDEM-0047-APPEND-G')
const appendedG = (await orderItems(targetOrder)).find((r) => r.origin === 'append')
assert(!!appendedG, 'append adds a new item row to the paid order')
assert(
  num(appendedG.line_amount) === 100 && num(appendedG.product_received_amount) === 0,
  'appended row carries line 100 with zero received',
)
let targetState = await orderState(targetOrder)
assert(
  num(targetState.tot) === 3409 && targetState.ps === 'partially_paid',
  'append re-derives total 3409 and flips payment back to partially_paid',
)

const gProof = await seedOrderProof(targetOrder)
await recordTransfer({
  orderId: targetOrder,
  amount: 100,
  allocations: [allocItem(targetOrder, appendedG.id, 100)],
  key: 'IDEM-0047-G',
  proof: gProof,
})
assert(
  (await orderState(targetOrder)).ps === 'fully_paid',
  'allocating the appended row restores fully_paid',
)

await expectReject(
  'deleting an order item that carries payment allocations is rejected',
  () => adjust(targetOrder, [{ id: appendedG.id, action: 'delete' }], 'IDEM-0047-DEL-G'),
  'Order item with payment allocations cannot be deleted',
)

await adjust(targetOrder, [{ ...item(1, 10, 0) }], 'IDEM-0047-APPEND-H')
const appendedH = (await orderItems(targetOrder)).filter((r) => r.origin === 'append')[1]
assert(!!appendedH, 'second append adds another item row without allocations')
await expectReject(
  'the 0030 order-level guard still blocks deleting any item once the order carries active allocations',
  () => adjust(targetOrder, [{ id: appendedH.id, action: 'delete' }], 'IDEM-0047-DEL-H'),
  'Order items cannot be deleted after an active payment allocation',
)
assert(
  (await scalar(
    `select count(*)::int from public.business_order_items where id='${appendedH.id}'`,
  )) === 1,
  'the unallocated appended row survives because the order-level guard rejects the delete',
)

assert(
  (await scalar(
    `select count(*)::int from public.business_order_payment_allocations a
     join public.business_customer_transfers t on t.id = a.transfer_id
     where a.order_id='${targetOrder}' and a.voided_at is null and t.voided_at is null`,
  )) === 4,
  'target order ends with exactly four active allocations (2 items + shipping + appended)',
)

console.log('ALL 0047 CHECKS PASSED')
await db.close()
