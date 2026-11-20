import { PGlite } from '@electric-sql/pglite'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = process.env.MIGRATIONS_DIR ?? path.resolve(here, '../../supabase/migrations')
const db = new PGlite()

await db.exec(`
  create schema auth;
  create schema extensions;
  create schema storage;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create function public.uuid_generate_v4() returns uuid language sql volatile as $$
    select gen_random_uuid()
  $$;
  create function extensions.digest(value text, algorithm text) returns bytea language sql immutable as $$
    select convert_to(value, 'UTF8')
  $$;
  create function public.digest(value text, algorithm text) returns bytea language sql immutable as $$
    select convert_to(value, 'UTF8')
  $$;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
  $$;
  create table storage.buckets (id text primary key, name text not null, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null references storage.buckets(id), name text not null, owner uuid, created_at timestamptz default now(), updated_at timestamptz default now(), unique (bucket_id, name));
  create function storage.foldername(name text) returns text[] language sql immutable as $$
    select case when strpos(name, '/') = 0 then array[]::text[] else string_to_array(regexp_replace(name, '/[^/]+$', ''), '/') end
  $$;
`)

const files = (await readdir(root))
  .filter((name) => /^\d{4}.*\.sql$/.test(name))
  .sort()
const target = files.find((name) => name.startsWith('0158_'))
assert.ok(target, '0158 migration missing')

await db.exec('begin')
for (const file of files) {
  if (file === target) continue
  let sql = await readFile(path.join(root, file), 'utf8')
  sql = sql
    .replace(/^create extension if not exists .*;\s*$/gim, '')
    .replace(/^create index[^;]*gin_trgm_ops\);\s*$/gim, '')
  await db.exec(sql)
}
const migration = await readFile(path.join(root, target), 'utf8')
await db.exec(migration)
await db.exec(migration) // idempotent re-run
console.log('PASS 0158 applied twice')

const adminId = '11111111-1111-4111-8111-111111111111'
const customerId = '22222222-2222-4222-8222-222222222222'
const shopId = '88888888-8888-4888-8888-888888888888'
const orderUsd = '33333333-3333-4333-8333-333333333333'
const orderCny = '44444444-4444-4444-8444-444444444444'
const tUsdNov = '55555555-5555-4555-8555-555555555555'
const tUsdOct = '66666666-6666-4666-8666-666666666666'
const tCnyNov = '77777777-7777-4777-8777-777777777777'

const proof = (id) => `${adminId}/customer/${customerId}/${id}.png`

await db.exec(`
  insert into auth.users (id, email) values ('${adminId}', 'admin@example.com');
  insert into public.profiles (id, email, full_name, role, status)
    values ('${adminId}', 'admin@example.com', 'Admin', 'admin', 'approved')
    on conflict (id) do nothing;
  select set_config('app.profile_mutation_rpc', 'role', false);
  update public.profiles set role = 'admin' where id = '${adminId}';
  select set_config('app.profile_mutation_rpc', 'lifecycle', false);
  update public.profiles set status = 'approved' where id = '${adminId}';
  select set_config('app.profile_mutation_rpc', '', false);
  insert into public.customers (id, name, country)
    values ('${customerId}', 'Test Customer', '美国')
    on conflict (id) do nothing;
  insert into public.finance_daily_order_shops (id, name, created_by)
    values ('${shopId}', 'Test Shop', '${adminId}')
    on conflict (id) do nothing;

  insert into public.business_orders
    (id, order_number, status, customer_id, customer_snapshot, salesperson_id, order_date,
     fulfillment_type, currency, exchange_rate_to_cny, items_subtotal, shipping_fee, total_amount,
     shop_id, shop_name_snapshot, external_order_number, daily_shipping_date, daily_payment_category,
     total_product_received_amount, total_shipping_received_amount, total_sales_amount, created_at)
  values
    ('${orderUsd}', 'BO-T-USD', 'approved', '${customerId}', '{"name":"Test Customer"}'::jsonb, '${adminId}',
     '2026-11-05', 'stock', 'USD', 7, 1000, 0, 1000,
     '${shopId}', 'Test Shop', 'EXT-1', '2026-11-06', 'full', 400, 0, 400, '2026-11-05 10:00:00+08'),
    ('${orderCny}', 'BO-T-CNY', 'approved', '${customerId}', '{"name":"Test Customer"}'::jsonb, '${adminId}',
     '2026-10-05', 'stock', 'CNY', 1, 2000, 0, 2000,
     '${shopId}', 'Test Shop', 'EXT-2', '2026-10-06', 'full', 500, 0, 500, '2026-10-05 10:00:00+08');

  insert into public.business_order_items
    (order_id, sku_snapshot, name_snapshot, unit_snapshot, quantity, unit_price, source_type)
  values
    ('${orderUsd}', 'SKU-1', 'Product USD', 'pcs', 1, 1000, 'legacy'),
    ('${orderCny}', 'SKU-2', 'Product CNY', 'pcs', 1, 2000, 'legacy');

  update public.business_order_items
    set product_received_amount = 400, daily_shipping_category = 'stock',
        logistics_fee_amount = 0, sales_total_amount = 400
    where order_id = '${orderUsd}';
  update public.business_order_items
    set product_received_amount = 500, daily_shipping_category = 'stock',
        logistics_fee_amount = 0, sales_total_amount = 500
    where order_id = '${orderCny}';

  insert into public.business_customer_transfers
    (id, customer_id, currency, amount, exchange_rate_to_cny, received_at, payment_type, proof_path, created_by)
  values
    ('${tUsdNov}', '${customerId}', 'USD', 100, 7, '2026-11-20 09:00:00+08', 'full', '${proof(tUsdNov)}', '${adminId}'),
    ('${tUsdOct}', '${customerId}', 'USD', 50, 7, '2026-10-20 09:00:00+08', 'full', '${proof(tUsdOct)}', '${adminId}'),
    ('${tCnyNov}', '${customerId}', 'CNY', 300, 1, '2026-11-10 09:00:00+08', 'full', '${proof(tCnyNov)}', '${adminId}');

  insert into public.business_order_payment_allocations
    (transfer_id, order_id, amount, payment_type, created_by)
  values
    ('${tUsdNov}', '${orderUsd}', 100, 'full', '${adminId}'),
    ('${tUsdOct}', '${orderUsd}', 50, 'full', '${adminId}'),
    ('${tCnyNov}', '${orderCny}', 300, 'full', '${adminId}');

  select set_config('request.jwt.claim.sub', '${adminId}', false);
`)


const num = (v) => Number(v)

async function summary(from, to) {
  const { rows } = await db.query(
    `select * from public.get_business_performance_summary(
       null::date, null::date, $1::date, $2::date, null::date, null::date,
       array['${adminId}']::uuid[], null::uuid[], null::uuid[], null::text[])`,
    [from, to],
  )
  return rows[0]
}

const sNov = await summary('2026-11-01', '2026-11-30')
assert.equal(num(sNov.order_count), 2, '订单数不受收款日期影响')
assert.equal(num(sNov.order_total_cny), 9000, '订单金额不受收款日期影响')
assert.equal(num(sNov.received_cny), 3800, `11月已收CNY: ${sNov.received_cny}`)
assert.equal(num(sNov.received_usd), 500, `11月已收USD: ${sNov.received_usd}`)
assert.equal(num(sNov.received_cny_native), 300, `11月已收CNY原币: ${sNov.received_cny_native}`)
assert.equal(num(sNov.outstanding_cny), 4350, `未收不受影响: ${sNov.outstanding_cny}`)

const sOct = await summary('2026-10-01', '2026-10-31')
assert.equal(num(sOct.received_cny), 500 + 350, `10月已收CNY: ${sOct.received_cny}`)
assert.equal(num(sOct.received_usd), 50, `10月已收USD: ${sOct.received_usd}`)
assert.equal(num(sOct.received_cny_native), 500, `10月已收CNY原币: ${sOct.received_cny_native}`)

const sNull = await summary(null, null)
assert.equal(num(sNull.received_cny), 4650, `不限已收CNY: ${sNull.received_cny}`)

const { rows: salespersonRows } = await db.query(
  `select * from public.get_business_performance_by_group(
     'salesperson', null, null, '2026-11-01'::date, '2026-11-30'::date, null, null,
     array['${adminId}']::uuid[], null::uuid[], null::uuid[], null::text[])`,
)
assert.equal(salespersonRows.length, 1)
assert.equal(num(salespersonRows[0].received_cny), 3800, `业务分组11月已收: ${salespersonRows[0].received_cny}`)
assert.equal(num(salespersonRows[0].order_count), 2)

const { rows: countryRows } = await db.query(
  `select * from public.get_business_performance_by_group(
     'country', null, null, '2026-11-01'::date, '2026-11-30'::date, null, null,
     array['${adminId}']::uuid[], null::uuid[], null::uuid[], null::text[])`,
)
assert.equal(countryRows.length, 1)
assert.equal(num(countryRows[0].received_cny), 3800, `国家分组11月已收: ${countryRows[0].received_cny}`)

const { rows: groupRows } = await db.query(
  `select * from public.get_business_performance_by_group(
     'product_group', null, null, '2026-11-01'::date, '2026-11-30'::date, null, null,
     array['${adminId}']::uuid[], null::uuid[], null::uuid[], null::text[])`,
)
const receivedTotal = groupRows.reduce((sum, row) => sum + num(row.received_cny), 0)
assert.equal(receivedTotal, 2800, `产品分组11月行级已收: ${receivedTotal}`)
assert.equal(groupRows.reduce((sum, row) => sum + num(row.order_count), 0), 2)

const { rows: nullGroup } = await db.query(
  `select * from public.get_business_performance_by_group(
     'product_group', null, null, null::date, null::date, null::date, null::date,
     array['${adminId}']::uuid[], null::uuid[], null::uuid[], null::text[])`,
)
assert.equal(
  nullGroup.reduce((sum, row) => sum + num(row.received_cny), 0),
  400 * 7 + 500,
  '产品分组不限收款日期',
)

console.log('PASS received-date filter semantics (summary / salesperson / country / product_group)')
await db.exec('rollback')
await db.close()
