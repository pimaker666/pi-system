import { readFile, readdir } from 'node:fs/promises'
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
const quote = (value) => (value === null || value === undefined ? 'null' : `'${String(value).replaceAll("'", "''")}'`)

assert(
  files.at(-1) === '0040_business_order_optional_number_rate_auto_approval.sql',
  '0040 is the latest migration in the empty-database replay',
)
assert(
  (await scalar(
    `select count(*)::int from pg_proc where proname = 'business_order_accepts_entry_edits'`,
  )) === 1,
  '0040 defines the shared entry-edit gate function',
)
assert(
  (await scalar(
    `select is_nullable from information_schema.columns
     where table_schema='public' and table_name='business_orders'
       and column_name='exchange_rate_to_cny'`,
  )) === 'YES',
  '0040 drops NOT NULL from business_orders.exchange_rate_to_cny',
)

const admin = '11111111-1111-4111-8111-111111111111'
const finance = '22222222-2222-4222-8222-222222222222'
const sales = '33333333-3333-4333-8333-333333333333'
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const customer = 'c0000000-0000-4000-8000-0000000000a1'

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
  insert into public.products (id, sku, name) values ('${productId}', 'SKU-0040', '0040 Product');
  insert into public.customers (id, name, created_by) values ('${customer}', '0040 Customer', '${sales}');
`)

await setUser(finance)
const shopUsd = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0040 USD Shop', null, true,
    array['${sales}','${admin}']::uuid[], 'USD'::public.currency_code)
`)
const shopCny = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0040 CNY Shop', null, true,
    array['${sales}','${admin}']::uuid[], 'CNY'::public.currency_code)
`)
assert(!!shopUsd && !!shopCny, 'finance seeds isolated shops for the rehearsal')

function items(receivedProduct, logistics, receivedSales) {
  return JSON.stringify([
    {
      product_id: productId,
      quantity: 1,
      unit_price: 100,
      daily_shipping_category: 'stock',
      product_received_amount: receivedProduct,
      product_received_overridden: receivedProduct !== 100,
      logistics_fee_amount: logistics,
      sales_total_amount: receivedSales,
      sales_total_overridden: receivedSales !== receivedProduct + logistics,
    },
  ])
}

function createV4({
  shop = shopUsd,
  currency = 'USD',
  rate = 7.2,
  external = null,
  receivedProduct = 100,
  receivedShipping = 10,
  receivedSales = 110,
  reason = null,
  label = 'X',
} = {}) {
  return db.query(`
    select * from public.create_business_order_v4(
      '${customer}', current_date, 'stock'::public.business_fulfillment_type,
      '${currency}'::public.currency_code, ${rate === null ? 'null' : rate}, 10,
      'TRACK-${label}', null,
      '${items(receivedProduct, receivedShipping, receivedSales)}'::jsonb, null,
      '${shop}', '${sales}', ${quote(external)},
      current_date, 'SHIP-${label}', 'full'::public.daily_order_payment_category,
      ${receivedProduct}, true, ${receivedShipping}, true, ${receivedSales}, true,
      ${quote(reason)})
  `)
}

async function updateV4(orderId, { rate = 7.2, external = null, label = 'U', receivedSales = 110 } = {}) {
  const version = await scalar(`select version from public.business_orders where id='${orderId}'`)
  return db.query(`
    select * from public.update_business_order_v4(
      '${orderId}', ${version}, '${customer}', current_date,
      'stock'::public.business_fulfillment_type, 'USD'::public.currency_code,
      ${rate === null ? 'null' : rate}, 10, 'TRACK-${label}', null,
      '${items(100, 10, receivedSales)}'::jsonb, null,
      null, '${shopUsd}', '${sales}', ${quote(external)}, current_date,
      'SHIP-${label}', 'full'::public.daily_order_payment_category,
      100, true, 10, true, ${receivedSales}, true, null)
  `)
}

// 1. 订单号与汇率非必填。
await setUser(sales)
const blankId = (await createV4({ rate: null, external: null, label: 'BLANK' })).rows[0].id
await asSuper()
let order = (
  await rows(
    `select status, external_order_number, exchange_rate_to_cny, total_cny, total_amount
     from public.business_orders where id='${blankId}'`,
  )
)[0]
assert(
  order.external_order_number === null && order.exchange_rate_to_cny === null,
  'sales creates a daily order with no external order number and no exchange rate',
)
assert(order.total_cny === null, 'a null exchange rate leaves total_cny null instead of a fake CNY amount')
assert(order.status === 'draft', 'a sales-created order still starts as a draft awaiting review')

await setUser(sales)
const cnyId = (await createV4({ shop: shopCny, currency: 'CNY', rate: null, label: 'CNY' })).rows[0].id
assert(!!cnyId, 'a CNY order is accepted without an exchange rate')
await expectReject(
  'a CNY order with an exchange rate other than one is still rejected',
  () => createV4({ shop: shopCny, currency: 'CNY', rate: 2, label: 'CNY-BAD' }),
  'CNY exchange rate must equal one',
)
await expectReject(
  'a non-positive exchange rate is still rejected',
  () => createV4({ rate: 0, label: 'RATE-0' }),
  'Exchange rate is invalid',
)

// 2. 差额原因非必填。
await setUser(sales)
const gapId = (await createV4({ receivedProduct: 80, receivedSales: 90, label: 'GAP' })).rows[0].id
await asSuper()
assert(
  (await scalar(
    `select receivable_received_difference_reason is null from public.business_orders where id='${gapId}'`,
  )) === true,
  'an under-received order is accepted with no difference reason',
)

// 3. 管理员与财务建单免审核。
await setUser(admin)
const adminOrder = (await createV4({ label: 'ADMIN' })).rows[0]
await setUser(finance)
const financeOrder = (await createV4({ label: 'FINANCE' })).rows[0]
await asSuper()
order = (
  await rows(
    `select status, approval_status, submitted_by, reviewed_by, review_note, version
     from public.business_orders where id='${adminOrder.id}'`,
  )
)[0]
assert(
  order.status === 'approved' && order.approval_status === 'approved',
  'an admin-created order is approved on creation without a review step',
)
assert(
  order.submitted_by === admin && order.reviewed_by === admin,
  'auto-approval records the admin as both submitter and reviewer',
)
assert(order.review_note === null, 'auto-approval leaves review_note empty so no rejection banner shows')
assert(
  Number(adminOrder.version) === Number(order.version),
  'create_business_order_v4 returns the post-approval version for the optimistic lock',
)
assert(
  (await scalar(
    `select count(*)::int from public.business_order_audit_logs
     where order_id='${adminOrder.id}' and action='approve'`,
  )) === 1,
  'auto-approval writes one approve audit row',
)
assert(
  (await scalar(`select status from public.business_orders where id='${financeOrder.id}'`)) === 'approved',
  'a finance-created order is approved on creation as well',
)

// 4. 免审核后管理员/财务仍可修正，业务员不可越权改已审核单。
assert(
  (await scalar(
    `select public.business_order_accepts_entry_edits('${adminOrder.id}', 'admin')`,
  )) === true,
  'the entry-edit gate opens for an admin on an approved order with no money and no shipment',
)
assert(
  (await scalar(
    `select public.business_order_accepts_entry_edits('${adminOrder.id}', 'sales')`,
  )) === false,
  'the entry-edit gate stays closed for sales on an approved order',
)
await setUser(admin)
assert(
  (await scalar(
    `select (public.get_business_order_edit_constraints('${adminOrder.id}')->>'can_edit_order')::boolean`,
  )) === true,
  'get_business_order_edit_constraints reports the approved order as editable for its admin',
)
await updateV4(adminOrder.id, { label: 'ADMIN-FIX', external: 'ADMIN-FIXED' })
await asSuper()
assert(
  (await scalar(
    `select external_order_number from public.business_orders where id='${adminOrder.id}'`,
  )) === 'ADMIN-FIXED',
  'an admin edits its own approved order to backfill the platform order number',
)

await setUser(sales)
const salesApproved = (await createV4({ label: 'SALES-APPROVED' })).rows[0]
await asSuper()
await db.exec(
  `update public.business_orders set status='approved', approval_status='approved' where id='${salesApproved.id}'`,
)
await setUser(sales)
await expectReject(
  'sales still cannot edit an approved order',
  () => updateV4(salesApproved.id, { label: 'SALES-BLOCKED' }),
  'Business order cannot be edited in current status',
)

// 5. 有发货事实后编辑重新锁死。
await setUser(admin)
const shippedOrder = (await createV4({ label: 'SHIPPED' })).rows[0]
await asSuper()
const shippedItemId = await scalar(
  `select id from public.business_order_items where order_id='${shippedOrder.id}' limit 1`,
)
await setUser(admin)
await db.query(`
  select public.create_business_order_shipment(
    '${shippedOrder.id}', now(), 'TRACK-SHIPPED', null,
    '[{"order_item_id":"${shippedItemId}","quantity":1}]'::jsonb, 'IDEM-SHIPPED')
`)
await asSuper()
assert(
  (await scalar(
    `select public.business_order_accepts_entry_edits('${shippedOrder.id}', 'admin')`,
  )) === false,
  'a shipment closes the entry-edit gate again',
)
await setUser(admin)
await expectReject(
  'an admin cannot edit an order that already shipped',
  () => updateV4(shippedOrder.id, { label: 'SHIPPED-FIX' }),
  'Business order cannot be edited in current status',
)

// 6. 收款口径：建单实收 + 后续流水。
await setUser(admin)
const paidSummary = (
  await rows(`select * from public.get_business_order_settlement_summary('${adminOrder.id}')`)
)[0]
assert(
  num(paidSummary.total_amount) === 110 &&
    num(paidSummary.allocated_amount) === 110 &&
    num(paidSummary.outstanding_amount) === 0,
  'the settlement summary folds the order-entry received total into the collected amount',
)
assert(
  paidSummary.payment_status === 'fully_paid',
  'an order fully received at entry time reaches fully_paid without a transfer',
)

await setUser(admin)
const partialOrder = (
  await createV4({ receivedProduct: 80, receivedSales: 90, label: 'PARTIAL' })
).rows[0]
await setUser(admin)
let partialSummary = (
  await rows(`select * from public.get_business_order_settlement_summary('${partialOrder.id}')`)
)[0]
assert(
  num(partialSummary.allocated_amount) === 90 && num(partialSummary.outstanding_amount) === 20,
  'a partially received order reports the entry amount as collected and the rest as outstanding',
)
assert(
  partialSummary.payment_status === 'partially_paid',
  'a partially received order is partially_paid',
)

await asSuper()
await db.exec(`
  insert into storage.objects(bucket_id, name, owner, metadata)
  values (
    'business-payment-proofs',
    '${finance}/customer/${customer}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab.jpg',
    '${finance}', '{"mimetype":"image/jpeg","size":"1024"}'::jsonb
  );
`)
await setUser(finance)
await db.query(`
  select public.record_business_customer_transfer(
    '${customer}', 'USD'::public.currency_code, 20, 7.2, now(),
    'balance'::public.business_payment_type,
    '${finance}/customer/${customer}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab.jpg',
    null, null, 'IDEM-TRANSFER-0040',
    '[{"order_id":"${partialOrder.id}","amount":20}]'::jsonb)
`)
await setUser(admin)
partialSummary = (
  await rows(`select * from public.get_business_order_settlement_summary('${partialOrder.id}')`)
)[0]
assert(
  num(partialSummary.allocated_amount) === 110 && num(partialSummary.outstanding_amount) === 0,
  'a later transfer allocation adds to the entry amount instead of replacing it',
)
assert(
  partialSummary.payment_status === 'fully_paid' &&
    (await scalar(`select payment_status from public.business_orders where id='${partialOrder.id}'`)) ===
      'fully_paid',
  'the stored payment_status matches the combined collection view',
)

console.log('ALL 0040 CHECKS PASSED')
await db.close()
