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

const quote = (value) =>
  value === null || value === undefined ? 'null' : `'${String(value).replaceAll("'", "''")}'`
const num = (value) => (value === null || value === undefined ? null : Number(value))

assert(
  files.includes('0043_business_order_item_append_revision.sql'),
  '0043 is included in the replay chain',
)
assert(
  (await scalar(
    `select count(*)::int from pg_proc where proname = 'adjust_business_order_items'`,
  )) === 1,
  '0043 replaces the adjust RPC in place',
)
assert(
  (await scalar(
    `select count(*)::int from pg_constraint where conname = 'business_order_items_origin_check'`,
  )) === 1,
  'origin check constraint exists',
)

const admin = '11111111-1111-4111-8111-111111111111'
const finance = '22222222-2222-4222-8222-222222222222'
const sales = '33333333-3333-4333-8333-333333333333'
const productP1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const productP2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const productP3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

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
  insert into public.products (id, sku, name) values
    ('${productP1}', 'SKU-0043-P1', '0043 Product One'),
    ('${productP2}', 'SKU-0043-P2', '0043 Product Two'),
    ('${productP3}', 'SKU-0043-P3', '0043 Product Three');
`)

await setUser(finance)
const shopId = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0043 USD Shop', null, true,
    array['${admin}','${sales}']::uuid[], 'USD'::public.currency_code)
`)
assert(!!shopId, 'finance seeds a shop for the rehearsal')

function createItems(productId, received) {
  return JSON.stringify([
    {
      product_id: productId,
      quantity: 1,
      unit_price: 100,
      daily_shipping_category: 'stock',
      product_received_amount: received,
      product_received_overridden: false,
      logistics_fee_amount: 0,
      sales_total_amount: received,
      sales_total_overridden: false,
    },
  ])
}

// 建单即启用日字段（覆盖标记为 false，后续加单/修订必须能重算合计）。
async function createApprovedOrder(label, productId) {
  await setUser(admin)
  const result = await db.query(`
    select * from public.create_business_order_v4(
      null, current_date, 'stock'::public.business_fulfillment_type,
      'USD'::public.currency_code, 7.2, 0, null, null,
      '${createItems(productId, 100)}'::jsonb, null, '${shopId}', '${sales}', '0043-${label}',
      current_date, 'SHIP-${label}', 'full'::public.daily_order_payment_category,
      100, false, 0, false, 100, false, null)
  `)
  return result.rows[0].id
}

const orderX = await createApprovedOrder('X', productP1)
const initialX = (
  await rows(`select status::text st, items_subtotal::numeric sub, total_amount::numeric tot,
                     total_product_received_amount::numeric pr, total_shipping_received_amount::numeric sr,
                     total_sales_amount::numeric sa, payment_status::text ps
              from public.business_orders where id='${orderX}'`)
)[0]
assert(
  initialX.st === 'approved' &&
    num(initialX.sub) === 100 &&
    num(initialX.pr) === 100 &&
    num(initialX.sr) === 0 &&
    num(initialX.sa) === 100,
  'order X starts approved with daily totals 100/0/100 (not overridden)',
)
const originalItem = (
  await rows(`select id, origin from public.business_order_items where order_id='${orderX}'`)
)[0]
assert(originalItem.origin === 'original', 'first-order item row is origin=original')

async function adjust(actorId, orderId, items, key, reasonType = 'add_on', version = null) {
  await setUser(actorId)
  const expected =
    version ?? (await scalar(`select version from public.business_orders where id='${orderId}'`))
  return db.query(
    `select public.adjust_business_order_items(
       '${orderId}', ${expected}, '${JSON.stringify(items)}'::jsonb,
       '${reasonType}', '0043 rehearsal', '${key}')`,
  )
}
async function orderState(orderId) {
  return (
    await rows(`select status::text st, approval_status::text ap, version::int v,
                       items_subtotal::numeric sub, total_amount::numeric tot,
                       total_product_received_amount::numeric pr,
                       total_shipping_received_amount::numeric sr,
                       total_sales_amount::numeric sa, payment_status::text ps
                from public.business_orders where id='${orderId}'`)
  )[0]
}

// A. 追加带完整日字段（手工覆盖实收 50/运费 5/合计 55）。
await adjust(
  finance,
  orderX,
  [
    {
      source_type: 'catalog',
      product_id: productP2,
      quantity: 2,
      unit_price: 30,
      daily_shipping_category: 'stock',
      product_received_amount: 50,
      product_received_overridden: true,
      logistics_fee_amount: 5,
      sales_total_amount: 55,
      sales_total_overridden: true,
    },
  ],
  'IDEM-0043-A',
)
let state = await orderState(orderX)
assert(
  num(state.sub) === 160 &&
    num(state.tot) === 160 &&
    num(state.pr) === 150 &&
    num(state.sr) === 5 &&
    num(state.sa) === 155,
  'append A recomputes order totals to subtotal 160 / product 150 / shipping 5 / sales 155',
)
assert(state.ps === 'partially_paid', 'payment_status flips to partially_paid after the append')
const appendRowA = (
  await rows(
    `select id, origin, quantity::numeric q, unit_price::numeric p, line_amount::numeric la,
            daily_shipping_category::text cat, product_received_amount::numeric pra,
            product_received_overridden::boolean pro, logistics_fee_amount::numeric lfa,
            sales_total_amount::numeric sta, sales_total_overridden::boolean sto
     from public.business_order_items where order_id='${orderX}' and origin='append'`,
  )
)[0]
assert(
  appendRowA &&
    num(appendRowA.q) === 2 &&
    num(appendRowA.p) === 30 &&
    num(appendRowA.la) === 60 &&
    appendRowA.cat === 'stock' &&
    num(appendRowA.pra) === 50 &&
    appendRowA.pro === true &&
    num(appendRowA.lfa) === 5 &&
    num(appendRowA.sta) === 55 &&
    appendRowA.sto === true,
  'append row A stores origin=append with the exact daily field values sent',
)

// B. 追加只带发货分类：实收默认=行金额，运费默认 0，合计=实收+运费。
await adjust(
  finance,
  orderX,
  [{ source_type: 'catalog', product_id: productP3, quantity: 1, unit_price: 10, daily_shipping_category: 'sample' }],
  'IDEM-0043-B',
)
const appendRowB = (
  await rows(
    `select id, product_received_amount::numeric pra, product_received_overridden::boolean pro,
            logistics_fee_amount::numeric lfa, sales_total_amount::numeric sta,
            sales_total_overridden::boolean sto
     from public.business_order_items where order_id='${orderX}' and origin='append'
     order by sort_order desc limit 1`,
  )
)[0]
assert(
  num(appendRowB.pra) === 10 &&
    appendRowB.pro === false &&
    num(appendRowB.lfa) === 0 &&
    num(appendRowB.sta) === 10 &&
    appendRowB.sto === false,
  'append B auto-defaults received=line amount, logistics=0, sales=received+logistics',
)
state = await orderState(orderX)
assert(
  num(state.sub) === 170 && num(state.pr) === 160 && num(state.sr) === 5 && num(state.sa) === 165,
  'append B moves totals to subtotal 170 / product 160 / shipping 5 / sales 165',
)

// C. 修订追加行：数量 1→2、单价 10、实收自动=行金额 20。
await adjust(
  finance,
  orderX,
  [
    {
      id: appendRowB.id,
      quantity: 2,
      unit_price: 10,
      daily_shipping_category: 'sample',
      product_received_amount: 20,
      product_received_overridden: false,
      logistics_fee_amount: 0,
      sales_total_amount: 20,
      sales_total_overridden: false,
    },
  ],
  'IDEM-0043-C',
  'quantity_fix',
)
state = await orderState(orderX)
assert(
  num(state.sub) === 180 && num(state.pr) === 170 && num(state.sr) === 5 && num(state.sa) === 175,
  'editing an appended row recomputes totals to subtotal 180 / product 170 / shipping 5 / sales 175',
)
const revisionC = (
  await rows(
    `select reason_type, detail from public.business_order_amount_revisions
     where order_id='${orderX}' order by revision_no desc limit 1`,
  )
)[0]
assert(
  revisionC.reason_type === 'quantity_fix' &&
    revisionC.detail.lines.some((line) => line.kind === 'updated' && line.order_item_id === appendRowB.id),
  'the edit writes a quantity_fix revision with an updated change line',
)

// D. 完全相同的修订 → 守卫拒绝。
await expectReject(
  'a no-op edit is rejected',
  () =>
    adjust(
      finance,
      orderX,
      [
        {
          id: appendRowB.id,
          quantity: 2,
          unit_price: 10,
          daily_shipping_category: 'sample',
          product_received_amount: 20,
          product_received_overridden: false,
          logistics_fee_amount: 0,
          sales_total_amount: 20,
          sales_total_overridden: false,
        },
      ],
      'IDEM-0043-D',
      'quantity_fix',
    ),
  'Adjustment does not change the order',
)

// E. 首次下单行不可修订、不可删除。
await expectReject(
  'original first-order row cannot be modified',
  () =>
    adjust(
      finance,
      orderX,
      [{ id: originalItem.id, quantity: 5, unit_price: 100 }],
      'IDEM-0043-E1',
      'quantity_fix',
    ),
  'Only appended order items can be modified',
)
await expectReject(
  'original first-order row cannot be deleted',
  () => adjust(finance, orderX, [{ id: originalItem.id, action: 'delete' }], 'IDEM-0043-E2', 'quantity_fix'),
  'Only appended order items can be deleted',
)

// F. 数量改小（无发货活动）允许。
await adjust(
  finance,
  orderX,
  [
    {
      id: appendRowB.id,
      quantity: 1,
      unit_price: 10,
      daily_shipping_category: 'sample',
      product_received_amount: 10,
      product_received_overridden: false,
      logistics_fee_amount: 0,
      sales_total_amount: 10,
      sales_total_overridden: false,
    },
  ],
  'IDEM-0043-F',
  'quantity_fix',
)
state = await orderState(orderX)
assert(
  num(state.sub) === 170 && num(state.pr) === 160 && num(state.sa) === 165,
  'decreasing an appended row quantity recomputes totals to subtotal 170 / product 160 / sales 165',
)

// G. 发货活动出现后：删除被拒、数量低于净已发被拒。
await asSuper()
await db.exec(`
  insert into public.business_order_shipments (order_id, shipped_at, created_by)
  values ('${orderX}', now(), '${finance}');
  insert into public.business_order_shipment_items (shipment_id, order_item_id, quantity)
  select s.id, '${appendRowB.id}', 1 from public.business_order_shipments s
  where s.order_id = '${orderX}';
`)
await expectReject(
  'appended row with shipment activity cannot be deleted',
  () => adjust(finance, orderX, [{ id: appendRowB.id, action: 'delete' }], 'IDEM-0043-G1', 'quantity_fix'),
  'Order item with shipment or return activity cannot be deleted',
)
await expectReject(
  'appended row quantity cannot drop below net shipped',
  () =>
    adjust(
      finance,
      orderX,
      [{ id: appendRowB.id, quantity: 0.5, unit_price: 10 }],
      'IDEM-0043-G2',
      'quantity_fix',
    ),
  'Quantity cannot be below net shipped quantity',
)

// H. 清理发货记录后删除另一条追加行：合计回落、收款状态回到已收齐口径。
await asSuper()
await db.exec(`
  delete from public.business_order_shipment_items where order_item_id = '${appendRowB.id}';
  delete from public.business_order_shipments where order_id = '${orderX}';
`)
await adjust(finance, orderX, [{ id: appendRowA.id, action: 'delete' }], 'IDEM-0043-H', 'quantity_fix')
state = await orderState(orderX)
assert(
  num(state.sub) === 110 &&
    num(state.tot) === 110 &&
    num(state.pr) === 110 &&
    num(state.sr) === 0 &&
    num(state.sa) === 110,
  'deleting an appended row recomputes totals to 110/110/0/110 (its received amounts leave the sums)',
)
assert(state.ps === 'fully_paid', 'payment_status returns to fully_paid once received matches the order total')
const settlement = (
  await rows(
    `select total_amount::numeric tot, outstanding_amount::numeric out, payment_status::text ps
     from public.get_business_order_settlement_summary('${orderX}')`,
  )
)[0]
assert(
  num(settlement.tot) === 110 && num(settlement.out) === 0 && settlement.ps === 'fully_paid',
  'settlement summary (transfer card source) reflects the recomputed totals and zero outstanding',
)

// I. 业务员本人追加仍自动重新提交审核，且实收合计一并重算。
const orderY = await createApprovedOrder('Y', productP1)
await adjust(
  sales,
  orderY,
  [
    {
      source_type: 'catalog',
      product_id: productP2,
      quantity: 1,
      unit_price: 40,
      daily_shipping_category: 'custom',
    },
  ],
  'IDEM-0043-I',
)
const stateY = await orderState(orderY)
assert(
  stateY.st === 'submitted' &&
    stateY.ap === 'submitted' &&
    num(stateY.sub) === 140 &&
    num(stateY.pr) === 140 &&
    num(stateY.sa) === 140,
  'sales append auto-resubmits and recomputes totals to subtotal 140 / product 140 / sales 140',
)
await expectReject(
  'sales cannot adjust while the order awaits review',
  () => adjust(sales, orderY, [{ source_type: 'catalog', product_id: productP2, quantity: 1, unit_price: 40 }], 'IDEM-0043-I2'),
  'Only approved orders can be adjusted by sales',
)

console.log('ALL 0043 CHECKS PASSED')
await db.close()
