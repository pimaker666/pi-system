import { PGlite } from '@electric-sql/pglite'
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = resolve(here, '../../supabase/migrations')
const db = new PGlite({ extensions: { uuid_ossp, pgcrypto, pg_trgm } })

await db.exec(`
  create schema auth;
  create schema extensions;
  create schema storage;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create role supabase_admin nologin;
  create extension if not exists pgcrypto;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
  $$;
  create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, owner_id text, created_at timestamptz default now(), updated_at timestamptz default now(), metadata jsonb);
  create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
  create function extensions.digest(data text, type text) returns bytea language sql immutable as $$ select public.digest(data, type) $$;
`)

const files = (await readdir(migrationsDir)).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()
async function apply(file) {
  await db.exec(await readFile(join(migrationsDir, file), 'utf8'))
}
for (const file of files) await apply(file)
console.log(`APPLY PASS ${files.length} migrations`)

const migration = '0064_business_performance_dashboard.sql'
if (!files.includes(migration)) throw new Error('FAIL 0064 migration not found')
await apply(migration)
console.log('PASS 0064 is idempotent')

await db.exec(`
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

async function setUser(userId) {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', '${userId}', false)`)
  await db.exec('set role authenticated')
}

const adminId = '11111111-1111-4111-8111-111111111111'
const salesAId = '22222222-2222-4222-8222-222222222222'
const salesBId = '33333333-3333-4333-8333-333333333333'
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const customerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values
    ('${adminId}', 'admin@example.com'),
    ('${salesAId}', 'sales-a@example.com'),
    ('${salesBId}', 'sales-b@example.com');
  update public.profiles set role='admin', status='approved', full_name='Admin', chinese_name='管理员' where id='${adminId}';
  update public.profiles set role='sales', status='approved', full_name='Sales A', chinese_name='业务A' where id='${salesAId}';
  update public.profiles set role='sales', status='approved', full_name='Sales B', chinese_name='业务B' where id='${salesBId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  insert into public.products (id, sku, name, unit, unit_price, currency) values
    ('${productId}', 'SKU-0064', '0064 Product', 'pcs', 100, 'USD');
  insert into public.customers (id, name, company, country, created_by) values
    ('${customerId}', 'Perf Customer', 'Perf Co', 'USA', '${salesAId}');
`)

await setUser(adminId)
const shopA = await scalar(`select id from public.save_finance_daily_order_shop(
  null, '店铺A', null, true, array['${adminId}', '${salesAId}']::uuid[], 'USD'::public.currency_code
)`)
const shopB = await scalar(`select id from public.save_finance_daily_order_shop(
  null, '店铺B', null, true, array['${adminId}', '${salesBId}']::uuid[], 'USD'::public.currency_code
)`)
assert(shopA && shopB, 'created two shops')

function makeItems(category, qty = 1, opts = {}) {
  const productReceivedAmount = opts.productReceivedAmount ?? 100 * qty
  const productReceivedOverridden = opts.productReceivedOverridden ?? false
  const logisticsFeeAmount = opts.logisticsFeeAmount ?? 0
  const salesTotalAmount = opts.salesTotalAmount ?? productReceivedAmount + logisticsFeeAmount
  const salesTotalOverridden = opts.salesTotalOverridden ?? false
  return JSON.stringify([{
    product_id: productId,
    quantity: qty,
    unit_price: 100,
    daily_shipping_category: category,
    product_received_amount: productReceivedAmount,
    product_received_overridden: productReceivedOverridden,
    logistics_fee_amount: logisticsFeeAmount,
    sales_total_amount: salesTotalAmount,
    sales_total_overridden: salesTotalOverridden,
  }])
}

async function createOrder(props) {
  const {
    orderDate,
    fulfillmentType,
    shopId,
    salespersonId,
    category,
    qty = 1,
    productReceivedAmount,
    productReceivedOverridden,
    salesTotalAmount,
    salesTotalOverridden,
    paymentDueDate,
  } = props
  const items = makeItems(category, qty, {
    productReceivedAmount,
    productReceivedOverridden,
    salesTotalAmount,
    salesTotalOverridden,
  })
  const effectiveProductReceived = productReceivedAmount ?? 100 * qty
  const effectiveProductOverridden = productReceivedOverridden ?? false
  const effectiveShippingReceived = 0
  const effectiveShippingOverridden = false
  const effectiveSalesTotal = salesTotalAmount ?? (100 * qty)
  const effectiveSalesOverridden = salesTotalOverridden ?? false
  const result = await db.query(`
    select * from public.create_business_order_v5(
      null, '${orderDate}', '${fulfillmentType}'::public.business_fulfillment_type,
      'USD'::public.currency_code, 7.0, 0, null, null,
      '${items}'::jsonb, ${paymentDueDate ? `'${paymentDueDate}'` : 'null'},
      '${shopId}', '${salespersonId}', 'EXT-${orderDate}-${fulfillmentType}', null, null,
      'full'::public.daily_order_payment_category,
      ${effectiveProductReceived}, ${effectiveProductOverridden},
      ${effectiveShippingReceived}, ${effectiveShippingOverridden},
      ${effectiveSalesTotal}, ${effectiveSalesOverridden},
      null, null
    )
  `)
  return result.rows[0]
}

// Sales A, Shop A, custom, 2026-09-01, 1 pcs, fully paid via daily entry
const orderA1 = await createOrder({
  orderDate: '2026-09-01',
  fulfillmentType: 'custom',
  shopId: shopA,
  salespersonId: salesAId,
  category: 'custom',
  qty: 1,
  totalSalesAmount: 100,
  paymentDueDate: '2026-09-10',
})
// Sales A, Shop A, stock, 2026-09-02, 2 pcs, fully paid via daily entry
const orderA2 = await createOrder({
  orderDate: '2026-09-02',
  fulfillmentType: 'stock',
  shopId: shopA,
  salespersonId: salesAId,
  category: 'stock',
  qty: 2,
  totalSalesAmount: 200,
  paymentDueDate: '2026-09-10',
})
// Sales B, Shop B, custom, 2026-09-03, 1 pcs, unpaid / overdue
const orderB1 = await createOrder({
  orderDate: '2026-09-03',
  fulfillmentType: 'custom',
  shopId: shopB,
  salespersonId: salesBId,
  category: 'custom',
  qty: 1,
  productReceivedAmount: 0,
  productReceivedOverridden: true,
  salesTotalAmount: 0,
  salesTotalOverridden: true,
  paymentDueDate: '2026-09-10',
})
// Sales B, Shop B, sample, 2026-08-15 (last month), 1 pcs, fully paid
const orderB2 = await createOrder({
  orderDate: '2026-08-15',
  fulfillmentType: 'stock',
  shopId: shopB,
  salespersonId: salesBId,
  category: 'sample',
  qty: 1,
  totalSalesAmount: 100,
  paymentDueDate: '2026-08-20',
})

assert(orderA1.id && orderA2.id && orderB1.id && orderB2.id, 'created four test orders')

// Coerce payment status to match our test expectations (PGlite current_date is 1970 otherwise
// but we use Asia/Shanghai; still set explicit statuses to avoid date surprises).
await db.exec(`
  update public.business_orders set payment_status='fully_paid' where id in ('${orderA1.id}', '${orderA2.id}', '${orderB2.id}');
  update public.business_orders set payment_status='unpaid' where id='${orderB1.id}';
`)

const summary = (await db.query(`
  select * from public.get_business_performance_summary(
    '2026-09-01'::date, '2026-09-30'::date,
    null, null, null, null
  )
`)).rows[0]
assert(Number(summary.order_count) === 3, `September summary sees 3 orders, got ${summary.order_count}`)
assert(Number(summary.order_total_amount) === 400, `September total amount = 400 USD, got ${summary.order_total_amount}`)
assert(Number(summary.order_total_cny) === 2800, `September total cny = 2800, got ${summary.order_total_cny}`)
assert(Number(summary.received_cny) === 2100, `September received cny = 2100, got ${summary.received_cny}`)
assert(Number(summary.outstanding_cny) === 700, `September outstanding cny = 700, got ${summary.outstanding_cny}`)

const noFilterSummary = (await db.query(`
  select * from public.get_business_performance_summary(null, null, null, null, null, null)
`)).rows[0]
assert(Number(noFilterSummary.order_count) === 4, `all-time summary sees 4 orders, got ${noFilterSummary.order_count}`)

const salesRows = (await db.query(`
  select * from public.get_business_performance_by_group(
    'salesperson',
    '2026-09-01'::date, '2026-09-30'::date,
    null, null, null, null
  )
`)).rows
assert(salesRows.length === 2, `September salesperson groups = 2, got ${salesRows.length}`)
const salesA = salesRows.find((r) => r.group_label === '业务A')
const salesB = salesRows.find((r) => r.group_label === '业务B')
assert(salesA && Number(salesA.order_count) === 2, 'Sales A has 2 September orders')
assert(salesB && Number(salesB.order_count) === 1, 'Sales B has 1 September order')

const shopRows = (await db.query(`
  select * from public.get_business_performance_by_group('shop', '2026-09-01'::date, '2026-09-30'::date, null, null, null, null)
`)).rows
assert(shopRows.length === 2, 'September shop groups = 2')

const dateRows = (await db.query(`
  select * from public.get_business_performance_by_group('date', '2026-09-01'::date, '2026-09-30'::date, null, null, null, null)
`)).rows
assert(dateRows.length === 3, `September date groups = 3, got ${dateRows.length}`)
assert(dateRows[0].group_key === '2026-09-01', 'date rows are chronological')

const monthRows = (await db.query(`
  select * from public.get_business_performance_by_group('month', null, null, null, null, null, null)
`)).rows
assert(monthRows.length === 2, `month groups = 2, got ${monthRows.length}`)

const fulfillmentRows = (await db.query(`
  select * from public.get_business_performance_by_group('fulfillment_type', null, null, null, null, null, null)
`)).rows
assert(fulfillmentRows.length === 2, 'fulfillment_type groups = 2')

const shippingRows = (await db.query(`
  select * from public.get_business_performance_by_group('shipping_category', null, null, null, null, null, null)
`)).rows
assert(shippingRows.length === 3, `shipping_category groups = 3, got ${shippingRows.length}`)
assert(shippingRows[0].group_key === 'custom', 'shipping order starts with custom')
assert(shippingRows[1].group_key === 'stock', 'shipping order second is stock')
assert(shippingRows[2].group_key === 'sample', 'shipping order third is sample')
const customRow = shippingRows.find((r) => r.group_key === 'custom')
assert(customRow && Number(customRow.order_count) === 2, 'custom shipping has 2 orders')
assert(customRow && Number(customRow.order_total_amount) === 200, 'custom shipping total amount = 200')

// Visibility: sales A only sees own orders.
await setUser(salesAId)
const salesASummary = (await db.query(`
  select * from public.get_business_performance_summary(null, null, null, null, null, null)
`)).rows[0]
assert(Number(salesASummary.order_count) === 2, `Sales A sees 2 orders, got ${salesASummary.order_count}`)

// Visibility: unrelated sales sees nothing.
const otherSalesId = '44444444-4444-4444-8444-444444444444'
await db.exec('reset role')
await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values ('${otherSalesId}', 'other@example.com');
  update public.profiles set role='sales', status='approved', full_name='Other' where id='${otherSalesId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
`)
await setUser(otherSalesId)
const otherSummary = (await db.query(`
  select * from public.get_business_performance_summary(null, null, null, null, null, null)
`)).rows[0]
assert(Number(otherSummary.order_count) === 0, 'unrelated salesperson sees 0 orders')

await db.exec('reset role')
assert(
  !(await scalar(`
    select has_function_privilege('anon',
      'public.get_business_performance_summary(date, date, uuid[], uuid[], text[], text[])', 'execute')
  `)),
  'anon cannot execute get_business_performance_summary',
)
assert(
  Boolean(await scalar(`
    select has_function_privilege('authenticated',
      'public.get_business_performance_summary(date, date, uuid[], uuid[], text[], text[])', 'execute')
  `)),
  'authenticated can execute get_business_performance_summary',
)

console.log('VERIFY PASS 0064')
await db.close()
