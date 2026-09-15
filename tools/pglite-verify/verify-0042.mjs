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

assert(files.at(-1) === '0042_adjust_business_order_items_open_roles.sql', '0042 is the latest migration')
assert(
  (await scalar(
    `select count(*)::int from pg_proc where proname = 'adjust_business_order_items'`,
  )) === 1,
  '0042 replaces the adjust RPC in place',
)

const admin = '11111111-1111-4111-8111-111111111111'
const finance = '22222222-2222-4222-8222-222222222222'
const sales = '33333333-3333-4333-8333-333333333333'
const otherSales = '44444444-4444-4444-8444-444444444444'
const productP1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const productP2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values
    ('${admin}', 'admin@example.com'),
    ('${finance}', 'finance@example.com'),
    ('${sales}', 'sales@example.com'),
    ('${otherSales}', 'other-sales@example.com');
  update public.profiles set role='admin', status='approved', full_name='Admin' where id='${admin}';
  update public.profiles set role='finance', status='approved', full_name='Finance' where id='${finance}';
  update public.profiles set role='sales', status='approved', full_name='Sales' where id='${sales}';
  update public.profiles set role='sales', status='approved', full_name='Other Sales' where id='${otherSales}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  insert into public.products (id, sku, name) values
    ('${productP1}', 'SKU-0042-P1', '0042 Product One'),
    ('${productP2}', 'SKU-0042-P2', '0042 Product Two');
`)

await setUser(finance)
const shopId = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0042 USD Shop', null, true,
    array['${admin}','${sales}','${otherSales}']::uuid[], 'USD'::public.currency_code)
`)
assert(!!shopId, 'finance seeds a shop for the append rehearsal')

function createItems(productId, received) {
  return JSON.stringify([
    {
      product_id: productId,
      quantity: 1,
      unit_price: 100,
      daily_shipping_category: 'stock',
      product_received_amount: received,
      product_received_overridden: true,
      logistics_fee_amount: 0,
      sales_total_amount: received,
      sales_total_overridden: true,
    },
  ])
}

async function createApprovedOrder(salespersonId, label, productId) {
  await setUser(admin)
  const result = await db.query(`
    select * from public.create_business_order_v4(
      null, current_date, 'stock'::public.business_fulfillment_type,
      'USD'::public.currency_code, 7.2, 0, null, null,
      '${createItems(productId, 100)}'::jsonb, null, '${shopId}', '${salespersonId}', '0042-${label}',
      current_date, 'SHIP-${label}', 'full'::public.daily_order_payment_category,
      100, true, 0, true, 100, true, null)
  `)
  return result.rows[0].id
}

const orderA = await createApprovedOrder(sales, 'A', productP1)
const orderB = await createApprovedOrder(otherSales, 'B', productP2)
const initialA = (
  await rows(`select status::text st, approval_status::text ap, version::int v,
                     items_subtotal::numeric sub, total_amount::numeric tot
              from public.business_orders where id='${orderA}'`)
)[0]
assert(
  initialA.st === 'approved' && initialA.ap === 'approved' && num(initialA.sub) === 100,
  'admin-created order A starts approved with subtotal 100',
)

async function append(actorId, orderId, items, key, { reason = '客户追单', version = null } = {}) {
  await setUser(actorId)
  const expected = version ?? (await scalar(`select version from public.business_orders where id='${orderId}'`))
  return db.query(
    `select public.adjust_business_order_items(
       '${orderId}', ${expected}, '${JSON.stringify(items)}'::jsonb,
       'add_on', ${quote(reason)}, '${key}')`,
  )
}
const catalogAppend = (productId, quantity, unitPrice = 100) => [
  { source_type: 'catalog', product_id: productId, quantity, unit_price: unitPrice },
]

await expectReject(
  'anonymous caller cannot append',
  () => setUser('').then(() =>
    db.query(`select public.adjust_business_order_items(
      '${orderA}', 1, '${JSON.stringify(catalogAppend(productP1, 1))}'::jsonb,
      'add_on', null, 'IDEM-0042-ANON')`),
  ),
  'Approved account required',
)

await expectReject(
  'another salesperson cannot append to order A',
  () => append(otherSales, orderA, catalogAppend(productP1, 1), 'IDEM-0042-FOREIGN'),
  'Sales user cannot adjust another owner business order',
)

await expectReject(
  'append with a stale version is rejected',
  () => append(finance, orderA, catalogAppend(productP1, 1), 'IDEM-0042-STALE', { version: 999 }),
  'Business order version conflict',
)

const financeAppend = await append(finance, orderA, catalogAppend(productP1, 2), 'IDEM-0042-FIN')
assert(financeAppend.rows.length === 1, 'finance append on an approved order succeeds')
const afterFinance = (
  await rows(`select status::text st, approval_status::text ap, version::int v,
                     items_subtotal::numeric sub, total_amount::numeric tot
              from public.business_orders where id='${orderA}'`)
)[0]
assert(
  afterFinance.st === 'approved' &&
    afterFinance.ap === 'approved' &&
    num(afterFinance.sub) === 300 &&
    num(afterFinance.tot) === 300,
  'finance append keeps the order approved and recalculates subtotal/total to 300',
)
const financeItems = await rows(
  `select quantity::numeric q, unit_price::numeric p, product_id
   from public.business_order_items where order_id='${orderA}' order by sort_order`,
)
assert(
  financeItems.length === 2 &&
    financeItems.every((item) => item.product_id === productP1) &&
    num(financeItems[0].q) === 1 &&
    num(financeItems[1].q) === 2,
  'same-product append creates a second independent row instead of merging quantities',
)

const financeRevision = (
  await rows(
    `select reason_type, reason from public.business_order_amount_revisions
     where order_id='${orderA}' order by revision_no desc limit 1`,
  )
)[0]
assert(
  financeRevision.reason_type === 'add_on' && financeRevision.reason === '客户追单',
  'finance append writes an add_on amount revision with the reason',
)

await expectReject(
  'reusing an idempotency key with a different payload is rejected',
  () => append(finance, orderA, catalogAppend(productP1, 3), 'IDEM-0042-FIN'),
  'Idempotency key was already used with a different payload',
)

const salesAppend = await append(sales, orderA, catalogAppend(productP1, 1), 'IDEM-0042-SALES')
assert(salesAppend.rows.length === 1, 'owner sales append on their approved order succeeds')
const afterSales = (
  await rows(`select status::text st, approval_status::text ap, version::int v,
                     items_subtotal::numeric sub, total_amount::numeric tot
              from public.business_orders where id='${orderA}'`)
)[0]
assert(
  afterSales.st === 'submitted' &&
    afterSales.ap === 'submitted' &&
    num(afterSales.sub) === 400 &&
    num(afterSales.tot) === 400,
  'sales append auto-resubmits the order (status/approval back to submitted) with subtotal 400',
)
const salesItems = await rows(
  `select quantity::numeric q from public.business_order_items
   where order_id='${orderA}' order by sort_order`,
)
assert(
  salesItems.length === 3 &&
    salesItems.map((item) => num(item.q)).join(',') === '1,2,1',
  'each append keeps its own row: order A now has three P1 rows (1,2,1)',
)
await asSuper()
const salesAudits = await rows(
  `select action::text a, reason from public.business_order_audit_logs
   where order_id='${orderA}' and action::text in ('update', 'submit')`,
)
assert(
  salesAudits.some((entry) => entry.a === 'submit' && entry.reason === '加单后自动重新提交审核') &&
    salesAudits.filter((entry) => entry.a === 'update' && entry.reason === '客户追单').length === 2,
  'each append writes an update audit, and the sales append adds a resubmit audit',
)

await expectReject(
  'sales cannot append again while the order awaits review',
  () => append(sales, orderA, catalogAppend(productP1, 1), 'IDEM-0042-SALES-PENDING'),
  'Only approved orders can be adjusted by sales',
)

const adminAppend = await append(admin, orderB, catalogAppend(productP2, 1), 'IDEM-0042-ADMIN')
assert(adminAppend.rows.length === 1, 'admin append on any not-completed order succeeds')
const afterAdmin = (
  await rows(`select status::text st, approval_status::text ap
              from public.business_orders where id='${orderB}'`)
)[0]
assert(
  afterAdmin.st === 'approved' && afterAdmin.ap === 'approved',
  'admin append on another owner order keeps it approved without review',
)

await asSuper()
await db.exec(`update public.business_orders set status='completed' where id='${orderB}'`)
await expectReject(
  'completed orders reject appends from any role',
  () => append(finance, orderB, catalogAppend(productP2, 1), 'IDEM-0042-COMPLETED'),
  'Completed business order is immutable',
)

console.log('ALL 0042 CHECKS PASSED')
await db.close()
