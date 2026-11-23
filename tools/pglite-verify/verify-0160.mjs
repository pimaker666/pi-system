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
  // PGlite 单事务重放不支持 concurrently（0113 的索引会被回滚重建，不影响断言）。
  sql = sql.replace(/create\s+(unique\s+)?index\s+concurrently/gi, 'create $1index')
  sql = sql.replace(/drop\s+index\s+concurrently/gi, 'drop index')
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
  (await scalar(
    `select count(*)::int from pg_proc
     where proname = 'adjust_business_order_items_internal_0141'
       and pg_get_functiondef(oid) like '%v_product_before%'`,
  )) === 1,
  '0160 replaces adjust_business_order_items_internal_0141 with the delta-shift body',
)

const admin = '11111111-1111-4111-8111-111111111111'
const finance = '22222222-2222-4222-8222-222222222222'
const sales = '33333333-3333-4333-8333-333333333333'
const productP1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const productP2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

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
    ('${productP1}', 'SKU-0160-P1', '0160 Product One'),
    ('${productP2}', 'SKU-0160-P2', '0160 Product Two');
`)

await setUser(finance)
const shopId = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0160 USD Shop', null, true,
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

// 建单时带上表头覆盖值（实收/运费/销售额 + 覆盖标记），模拟「先手改表头、再追加」。
async function createOrder(label, header) {
  const h = Object.assign(
    {
      product: 100,
      productOverridden: false,
      shipping: 0,
      shippingOverridden: false,
      sales: 100,
      salesOverridden: false,
    },
    header,
  )
  await setUser(admin)
  const result = await db.query(`
    select * from public.create_business_order_v4(
      null, current_date, 'stock'::public.business_fulfillment_type,
      'USD'::public.currency_code, 7.2, 0, null, null,
      '${createItems(productP1, 100)}'::jsonb, null, '${shopId}', '${sales}', '0160-${label}',
      current_date, 'SHIP-${label}', 'full'::public.daily_order_payment_category,
      ${h.product}, ${h.productOverridden}, ${h.shipping}, ${h.shippingOverridden},
      ${h.sales}, ${h.salesOverridden}, null)
  `)
  return result.rows[0].id
}

async function adjust(actorId, orderId, items, key, reasonType = 'add_on', version = null) {
  await setUser(actorId)
  const expected =
    version ?? (await scalar(`select version from public.business_orders where id='${orderId}'`))
  return db.query(
    `select public.adjust_business_order_items(
       '${orderId}', ${expected}, '${JSON.stringify(items)}'::jsonb,
       '${reasonType}', '0160 rehearsal', '${key}')`,
  )
}

async function orderState(orderId) {
  return (
    await rows(`select status::text st, items_subtotal::numeric sub, total_amount::numeric tot,
                       total_product_received_amount::numeric pr,
                       total_product_received_overridden::boolean pro,
                       total_shipping_received_amount::numeric sr,
                       total_shipping_received_overridden::boolean sro,
                       total_sales_amount::numeric sa,
                       total_sales_overridden::boolean sao,
                       payment_status::text ps
                from public.business_orders where id='${orderId}'`)
  )[0]
}

// A. 回归 0043 口径：无表头覆盖时追加带行级覆盖的明细，表头按行合计重算。
const orderA = await createOrder('A')
const startA = await orderState(orderA)
assert(
  num(startA.pr) === 100 && startA.pro === false && num(startA.sa) === 100 && startA.sao === false,
  'A starts with header 100/100 from item sums without overrides',
)
const versionA = await scalar(`select version from public.business_orders where id='${orderA}'`)
const itemsA = [
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
]
await adjust(finance, orderA, itemsA, 'IDEM-0160-A', 'add_on', versionA)
let state = await orderState(orderA)
assert(
  num(state.sub) === 160 && num(state.tot) === 160 &&
    num(state.pr) === 150 && state.pro === false &&
    num(state.sr) === 5 && state.sro === false &&
    num(state.sa) === 155 && state.sao === false,
  'A regression: append recomputes header to 150/5/155 with overrides still off (0043 behavior)',
)

// B. 表头覆盖值等于追加前的明细合计（旧自动合计残留）→ 清除覆盖，表头跟随新行合计。
//    复现 BO-2026-0208：表头停在 100，追加行自带实收 2,500。
const orderB = await createOrder('B', {
  product: 100,
  productOverridden: true,
  sales: 100,
  salesOverridden: true,
})
await adjust(
  finance,
  orderB,
  [
    {
      source_type: 'catalog',
      product_id: productP2,
      quantity: 27,
      unit_price: 100,
      daily_shipping_category: 'stock',
      product_received_amount: 2500,
      product_received_overridden: true,
      logistics_fee_amount: 0,
      sales_total_amount: 2500,
      sales_total_overridden: true,
    },
  ],
  'IDEM-0160-B',
)
state = await orderState(orderB)
assert(
  num(state.pr) === 2600 && state.pro === false,
  'B: stale header override (100 = pre-append sum) is cleared and header follows item sum 2,600',
)
assert(
  num(state.sa) === 2600 && state.sao === false,
  'B: stale sales override is cleared and header sales follows 2,600',
)
assert(num(state.tot) === 2800, 'B: order total_amount follows the items subtotal 2,800')

// C. 表头覆盖值是相对明细合计的真实差额 → 按本次变动量平移，覆盖保留。
const orderC = await createOrder('C', {
  product: 150,
  productOverridden: true,
  shipping: 7,
  shippingOverridden: true,
  sales: 157,
  salesOverridden: true,
})
const startC = await orderState(orderC)
assert(
  num(startC.pr) === 150 && startC.pro === true &&
    num(startC.sr) === 7 && startC.sro === true &&
    num(startC.sa) === 157 && startC.sao === true,
  `C starts with header overrides 150/7/157 (got ${JSON.stringify(startC)})`,
)
await adjust(
  finance,
  orderC,
  [
    {
      source_type: 'catalog',
      product_id: productP2,
      quantity: 1,
      unit_price: 40,
      daily_shipping_category: 'custom',
      product_received_amount: 40,
      product_received_overridden: false,
      logistics_fee_amount: 5,
      sales_total_amount: 45,
      sales_total_overridden: false,
    },
  ],
  'IDEM-0160-C',
)
state = await orderState(orderC)
assert(
  num(state.pr) === 190 && state.pro === true,
  'C: product override 150 shifts by the +40 item delta to 190 and stays overridden',
)
assert(
  num(state.sr) === 12 && state.sro === true,
  'C: shipping override 7 shifts by the +5 item delta to 12 and stays overridden',
)
assert(
  num(state.sa) === 202 && state.sao === false,
  'C: sales total normalizes to product+shipping 202 and the sales override flag is dropped',
)

// D. 删除追加行时覆盖值按差额回落，不会残留虚增。
await adjust(finance, orderC, [{ id: (await rows(
  `select id from public.business_order_items where order_id='${orderC}' and origin='append'`,
))[0].id, action: 'delete' }], 'IDEM-0160-D', 'quantity_fix')
state = await orderState(orderC)
assert(
  num(state.pr) === 150 && state.pro === true &&
    num(state.sr) === 7 && state.sro === true &&
    num(state.sa) === 157 && state.sao === false,
  'D: deleting the appended row shifts product/shipping overrides back to 150/7 and sales to 157',
)

// E. 业务员追加走「重新提交审核」分支时同样清掉旧自动合计残留。
const orderE = await createOrder('E', {
  product: 100,
  productOverridden: true,
  sales: 100,
  salesOverridden: true,
})
await adjust(
  sales,
  orderE,
  [
    {
      source_type: 'catalog',
      product_id: productP2,
      quantity: 1,
      unit_price: 40,
      daily_shipping_category: 'custom',
    },
  ],
  'IDEM-0160-E',
)
state = await orderState(orderE)
assert(
  state.st === 'submitted' && num(state.pr) === 140 && state.pro === false &&
    num(state.sa) === 140 && state.sao === false,
  'E: sales resubmit branch also clears the stale override and recomputes to 140/140',
)

// F. 幂等：同一 idempotency key（同 payload 同版本）重放不重复加行、不改表头。
await adjust(finance, orderA, itemsA, 'IDEM-0160-A', 'add_on', versionA)
state = await orderState(orderA)
assert(
  num(state.sub) === 160 && num(state.pr) === 150 && num(state.sr) === 5 && num(state.sa) === 155,
  'F: replaying the same idempotency key leaves A at 160/150/5/155',
)

console.log('ALL 0160 CHECKS PASSED')
await db.close()
