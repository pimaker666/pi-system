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
const target = files.find((name) => name.startsWith('0163_'))
assert.ok(target, '0163 migration missing')

for (const file of files) {
  if (file === target) continue
  let sql = await readFile(path.join(root, file), 'utf8')
  sql = sql
    .replace(/^create extension if not exists .*;\s*$/gim, '')
    .replace(/^create index concurrently[^;]*;\s*$/gim, '')
    .replace(/^create index[^;]*gin_trgm_ops\);\s*$/gim, '')
  await db.exec(sql)
}
const migration = await readFile(path.join(root, target), 'utf8')
await db.exec(migration)
await db.exec(migration) // idempotent re-run
console.log('PASS 0163 applied twice')

const adminId = '11111111-1111-4111-8111-111111111111'
const customerId = '22222222-2222-4222-8222-222222222222'
const shopId = '88888888-8888-4888-8888-888888888888'
const orderA = '33333333-3333-4333-8333-333333333333' // USD，10-21 下单，11-17 追加收款
const orderB = '44444444-4444-4444-8444-444444444444' // CNY，09-05 下单，只有 11-08 追加收款
const tA = '55555555-5555-4555-8555-555555555555'

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
    ('${orderA}', 'BO-T-A', 'approved', '${customerId}', '{"name":"Test Customer"}'::jsonb, '${adminId}',
     '2026-10-21', 'custom', 'USD', 7, 2075.25, 0, 2075.25,
     '${shopId}', 'Test Shop', 'EXT-A', '2026-10-22', 'full', 2075.25, 0, 2075.25, '2026-10-21 07:38:30+00'),
    ('${orderB}', 'BO-T-B', 'approved', '${customerId}', '{"name":"Test Customer"}'::jsonb, '${adminId}',
     '2026-09-05', 'custom', 'CNY', 1, 1050, 0, 1050,
     '${shopId}', 'Test Shop', 'EXT-B', '2026-09-06', 'full', 1050, 0, 1050, '2026-09-05 02:00:00+00');

  insert into public.business_order_items
    (order_id, sku_snapshot, name_snapshot, unit_snapshot, quantity, unit_price, source_type, origin, created_at)
  values
    ('${orderA}', 'SKU-A1', 'Product A Original', 'pcs', 2000, 0.99375, 'legacy', 'original', '2026-10-21 07:38:30+00'),
    ('${orderA}', 'SKU-A2', 'Product A Append', 'pcs', 50, 1.755, 'legacy', 'append', '2026-11-17 03:48:15+00'),
    ('${orderB}', 'SKU-B1', 'Product B Original', 'pcs', 1, 1000, 'legacy', 'original', '2026-09-05 02:00:00+00'),
    ('${orderB}', 'SKU-B2', 'Product B Append', 'pcs', 1, 50, 'legacy', 'append', '2026-11-08 02:00:00+00');

  update public.business_order_items
    set daily_shipping_category = 'custom', product_received_amount = 1987.50,
        logistics_fee_amount = 0, sales_total_amount = 1987.50
    where order_id = '${orderA}' and origin = 'original';
  update public.business_order_items
    set daily_shipping_category = 'custom', product_received_amount = 87.75,
        logistics_fee_amount = 0, sales_total_amount = 87.75
    where order_id = '${orderA}' and origin = 'append';
  update public.business_order_items
    set daily_shipping_category = 'custom', product_received_amount = 1000,
        logistics_fee_amount = 0, sales_total_amount = 1000
    where order_id = '${orderB}' and origin = 'original';
  update public.business_order_items
    set daily_shipping_category = 'custom', product_received_amount = 50,
        logistics_fee_amount = 0, sales_total_amount = 50
    where order_id = '${orderB}' and origin = 'append';

  update public.business_orders set total_sales_amount = 2075.25, total_product_received_amount = 2075.25
    where id = '${orderA}';
  update public.business_orders set total_sales_amount = 1050, total_product_received_amount = 1050
    where id = '${orderB}';

  insert into public.business_customer_transfers
    (id, customer_id, currency, amount, exchange_rate_to_cny, received_at, payment_type, proof_path, created_by)
  values
    ('${tA}', '${customerId}', 'USD', 100, 7, '2026-11-20 09:00:00+08', 'full', '${proof(tA)}', '${adminId}');

  insert into public.business_order_payment_allocations
    (transfer_id, order_id, amount, payment_type, created_by)
  values
    ('${tA}', '${orderA}', 100, 'full', '${adminId}');

  select set_config('request.jwt.claim.sub', '${adminId}', false);
`)

const { rows: orderCheck } = await db.query(`
  select id, order_date, total_sales_amount, exchange_rate_to_cny,
         (select string_agg(origin || ':' || sales_total_amount::text, ',' order by created_at)
            from public.business_order_items where order_id = business_orders.id) as items
  from public.business_orders order by order_number
`)
assert.equal(Number(orderCheck[0].total_sales_amount), 2075.25, `A 表头合计: ${orderCheck[0].total_sales_amount}`)
assert.equal(Number(orderCheck[1].total_sales_amount), 1050, `B 表头合计: ${orderCheck[1].total_sales_amount}`)

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

// 11 月：A 追加 87.75*7 + 转账 100*7；B 追加 50
const sNov = await summary('2026-11-01', '2026-11-30')
assert.equal(num(sNov.order_count), 2, `11月订单数: ${sNov.order_count}`)
assert.equal(num(sNov.received_cny), 614.25 + 700 + 50, `11月已收CNY: ${sNov.received_cny}`)
assert.equal(num(sNov.received_usd), 87.75 + 100, `11月已收USD: ${sNov.received_usd}`)
assert.equal(num(sNov.received_cny_native), 50, `11月已收CNY原币: ${sNov.received_cny_native}`)
assert.equal(num(sNov.order_total_cny), 2075.25 * 7 + 1050, `11月订单总额: ${sNov.order_total_cny}`)
assert.equal(num(sNov.outstanding_cny), 0, `11月未收: ${sNov.outstanding_cny}`)

// 10 月：A 表头 2075.25 扣掉追加 87.75 后归下单日
const sOct = await summary('2026-10-01', '2026-10-31')
assert.equal(num(sOct.order_count), 1, `10月订单数: ${sOct.order_count}`)
assert.equal(num(sOct.received_cny), 1987.5 * 7, `10月已收CNY: ${sOct.received_cny}`)
assert.equal(num(sOct.received_usd), 1987.5, `10月已收USD: ${sOct.received_usd}`)

// 9 月：B 表头 1050 扣掉追加 50
const sSep = await summary('2026-09-01', '2026-09-30')
assert.equal(num(sSep.order_count), 1, `9月订单数: ${sSep.order_count}`)
assert.equal(num(sSep.received_cny), 1000, `9月已收CNY: ${sSep.received_cny}`)

// 不限收款日期：总额口径与修改前一致
const sAll = await summary(null, null)
assert.equal(num(sAll.received_cny), 2075.25 * 7 + 700 + 1050, `不限已收CNY: ${sAll.received_cny}`)
assert.equal(num(sAll.received_usd), 2075.25 + 100, `不限已收USD: ${sAll.received_usd}`)
assert.equal(num(sAll.received_cny_native), 1050, `不限已收CNY原币: ${sAll.received_cny_native}`)

// 月份行不限收款窗口：收款按下单日/追加日分别落在 10/11/9 月
const { rows: monthRows } = await db.query(
  `select * from public.get_business_performance_by_group(
     'month', null, null, null::date, null::date, null, null,
     array['${adminId}']::uuid[], null::uuid[], null::uuid[], null::text[])`,
)
const nov = monthRows.find((r) => r.group_key === '2026-11')
const oct = monthRows.find((r) => r.group_key === '2026-10')
const sep = monthRows.find((r) => r.group_key === '2026-09')
assert.ok(nov && oct && sep, `月份行: ${monthRows.map((r) => r.group_key).join(',')}`)
assert.equal(num(nov.received_cny), 1364.25, `月份11月已收: ${nov.received_cny}`)
assert.equal(num(oct.received_cny), 13912.5, `月份10月已收: ${oct.received_cny}`)
assert.equal(num(sep.received_cny), 1000, `月份9月已收: ${sep.received_cny}`)
assert.equal(num(oct.order_count), 1, `月份10月订单数: ${oct.order_count}`)
assert.equal(num(sep.order_count), 1, `月份9月订单数: ${sep.order_count}`)
assert.equal(num(nov.order_count), 0, `月份行订单数仍按下单日: ${nov.order_count}`)

// 收款窗口为 11 月时，10/9 月的表头收款不应再出现在月份行里
const { rows: monthRowsNov } = await db.query(
  `select * from public.get_business_performance_by_group(
     'month', null, null, '2026-11-01'::date, '2026-11-30'::date, null, null,
     array['${adminId}']::uuid[], null::uuid[], null::uuid[], null::text[])`,
)
const novWin = monthRowsNov.find((r) => r.group_key === '2026-11')
assert.equal(num(novWin.received_cny), 1364.25, `11月窗口月份已收: ${novWin.received_cny}`)
assert.equal(
  monthRowsNov.filter((r) => r.group_key !== '2026-11').reduce((s, r) => s + num(r.received_cny), 0),
  0,
  `11月窗口下其他月份已收应清零: ${monthRowsNov.map((r) => `${r.group_key}=${r.received_cny}`).join(',')}`,
)

const { rows: salesRows } = await db.query(
  `select * from public.get_business_performance_by_group(
     'salesperson', null, null, '2026-11-01'::date, '2026-11-30'::date, null, null,
     array['${adminId}']::uuid[], null::uuid[], null::uuid[], null::text[])`,
)
assert.equal(salesRows.length, 1)
assert.equal(num(salesRows[0].received_cny), 1364.25, `业务11月已收: ${salesRows[0].received_cny}`)
assert.equal(num(salesRows[0].order_count), 2)

const { rows: countryRows } = await db.query(
  `select * from public.get_business_performance_by_group(
     'country', null, null, '2026-11-01'::date, '2026-11-30'::date, null, null,
     array['${adminId}']::uuid[], null::uuid[], null::uuid[], null::text[])`,
)
assert.equal(countryRows.length, 1)
assert.equal(num(countryRows[0].received_cny), 1364.25, `国家11月已收: ${countryRows[0].received_cny}`)

const { rows: groupRows } = await db.query(
  `select * from public.get_business_performance_by_group(
     'product_group', null, null, '2026-11-01'::date, '2026-11-30'::date, null, null,
     array['${adminId}']::uuid[], null::uuid[], null::uuid[], null::text[])`,
)
assert.equal(
  groupRows.reduce((sum, row) => sum + num(row.received_cny), 0),
  664.25,
  `产品分组11月行级已收: ${groupRows.map((r) => r.received_cny).join(',')}`,
)

const { rows: shipRows } = await db.query(
  `select * from public.get_business_performance_by_group(
     'shipping_category', null, null, '2026-11-01'::date, '2026-11-30'::date, null, null,
     array['${adminId}']::uuid[], null::uuid[], null::uuid[], null::text[])`,
)
assert.equal(
  shipRows.reduce((sum, row) => sum + num(row.received_cny), 0),
  664.25,
  `发货分类11月行级已收: ${shipRows.map((r) => r.received_cny).join(',')}`,
)

// 追加收款作为唯一 11 月活动的订单，也要进入产品业绩
const { rows: productRows } = await db.query(
  `select * from public.get_business_performance_by_product(
     'legacy', null, null, '2026-11-01'::date, '2026-11-30'::date, null, null,
     array['${adminId}']::uuid[], null::uuid[], null::uuid[], null::text[])`,
)
assert.equal(productRows.length, 4, `产品业绩行数: ${productRows.map((r) => r.product_name).join(',')}`)
const productBAppend = productRows.find((r) => r.product_name === 'Product B Append')
assert.ok(productBAppend, `B 追加行应进入产品业绩: ${productRows.map((r) => r.product_name).join(',')}`)
assert.equal(num(productBAppend.sales_amount_cny), 50, `产品业绩B追加销售额: ${productBAppend.sales_amount_cny}`)
assert.equal(
  productRows.reduce((s, r) => s + num(r.sales_amount_cny), 0),
  1050,
  `产品业绩CNY销售合计: ${productRows.map((r) => r.sales_amount_cny).join(',')}`,
)

const { rows: multiRows } = await db.query(
  `select * from public.get_business_performance_multi_dimension(
     'month', null, null, null, null, '2026-11-01'::date, '2026-11-30'::date, null, null,
     array['${adminId}']::uuid[], null::uuid[], null::uuid[], null::text[])`,
)
assert.equal(
  multiRows.reduce((sum, row) => sum + num(row.order_count), 0),
  2,
  `多维订单数: ${multiRows.map((r) => r.order_count).join(',')}`,
)

console.log('PASS 0163 append receipts attribution (summary / month / salesperson / country / product_group / shipping_category / by_product / multi_dimension)')
await db.close()
