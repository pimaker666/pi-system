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

const migration = '0102_live_product_group_performance.sql'
if (files.at(-1) !== migration) throw new Error(`FAIL ${migration} is not the latest migration`)
await apply(migration)
console.log('PASS 0102 is idempotent')

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`)
  console.log(`PASS ${message}`)
}

const adminId = '11111111-1111-4111-8111-111111111111'
const customerA = '22222222-2222-4222-8222-222222222221'
const groupMask = '55555555-5555-4555-8555-555555555551'
const groupCream = '55555555-5555-4555-8555-555555555552'
const productMask = '66666666-6666-4666-8666-666666666661'
const productLoose = '66666666-6666-4666-8666-666666666662'
const customProduct = '77777777-7777-4777-8777-777777777771'
const customV1 = '88888888-8888-4888-8888-888888888881'
const customV2 = '88888888-8888-4888-8888-888888888882'
const orderMixed = '99999999-9999-4999-8999-999999999991'
const orderLoose = '99999999-9999-4999-8999-999999999992'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values ('${adminId}', 'admin@example.com');
  update public.profiles set role='admin', status='approved' where id='${adminId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;

  insert into public.customers (id, name, created_by) values ('${customerA}', 'Customer A', '${adminId}');

  insert into public.product_groups (id, name, sort_order, created_by) values
    ('${groupMask}', '面膜', 1, '${adminId}'),
    ('${groupCream}', '面霜', 2, '${adminId}');

  insert into public.products (id, sku, name, unit, unit_price, currency, group_id, created_by) values
    ('${productMask}', 'P-0102-MASK', '普通面膜', 'pcs', 10, 'USD', '${groupMask}', '${adminId}'),
    ('${productLoose}', 'P-0102-LOOSE', '未分组产品', 'pcs', 50, 'USD', null, '${adminId}');

  insert into public.business_custom_products (id, customer_id, created_by) values
    ('${customProduct}', '${customerA}', '${adminId}');

  insert into public.business_custom_product_versions (
    id, custom_product_id, version_no, code, name, unit,
    default_unit_price, default_currency, product_group_id, created_by
  ) values (
    '${customV1}', '${customProduct}', 1, 'C-0102-V1', '定制面膜', 'pcs',
    40, 'USD', '${groupMask}', '${adminId}'
  );

  insert into public.business_orders (
    id, order_number, customer_id, customer_snapshot, salesperson_id, order_date,
    fulfillment_type, currency, exchange_rate_to_cny, items_subtotal, shipping_fee, total_amount
  ) values
    ('${orderMixed}', 'PERF-0102-1', '${customerA}', '{"name":"Customer A"}'::jsonb, '${adminId}',
     current_date, 'stock', 'USD', 7, 300, 0, 300),
    ('${orderLoose}', 'PERF-0102-2', '${customerA}', '{"name":"Customer A"}'::jsonb, '${adminId}',
     current_date, 'stock', 'USD', 7, 50, 0, 50);

  insert into public.business_order_items (
    order_id, source_type, product_id, custom_product_id, custom_product_version_id,
    sku_snapshot, name_snapshot, unit_snapshot, quantity, unit_price
  ) values
    ('${orderMixed}', 'catalog', '${productMask}', null, null,
     'P-0102-MASK', '普通面膜', 'pcs', 10, 10),
    ('${orderMixed}', 'custom', null, '${customProduct}', '${customV1}',
     'C-0102-V1', '定制面膜', 'pcs', 5, 40),
    ('${orderLoose}', 'catalog', '${productLoose}', null, null,
     'P-0102-LOOSE', '未分组产品', 'pcs', 1, 50);
`)

await db.exec('reset role')
await db.query(`select set_config('request.jwt.claim.sub', '${adminId}', false)`)
await db.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`)
await db.exec('set role authenticated')

async function byGroup(groupIds = null) {
  const rows = (await db.query(
    `select * from public.get_business_performance_by_group('product_group', null, null, null, null, $1, null)`,
    [groupIds],
  )).rows
  return new Map(rows.map((row) => [row.group_key, row]))
}

function amount(rows, key, column) {
  const row = rows.get(key)
  return row ? Number(row[column]) : null
}

// 初始口径：普通产品分组与定制产品最新版本分组都要计入同一个分组
const initial = await byGroup()
assert(initial.size === 2, 'product_group 维度返回 面膜/面霜 之外的两个分组桶')
assert(amount(initial, groupMask, 'order_total_cny') === 2100, '普通产品与定制产品行都归入实时分组（面膜 2100 CNY）')
assert(Number(initial.get(groupMask).order_count) === 1, '面膜分组订单数为 1')
assert(amount(initial, '', 'order_total_cny') === 350, '无分组产品仍归入 (未分组)')
assert(initial.get(groupMask).group_label === '面膜', '分组名称取自 product_groups')

const summaryInitial = (await db.query(
  `select * from public.get_business_performance_summary(null, null, null, null, $1, null)`,
  [[groupMask]],
)).rows[0]
assert(Number(summaryInitial.order_count) === 1, '汇总卡按分组筛选计入含普通产品行的订单')
assert(Number(summaryInitial.order_total_cny) === 2100, '汇总卡按分组筛选返回订单总额 CNY')

const summaryCream = (await db.query(
  `select * from public.get_business_performance_summary(null, null, null, null, $1, null)`,
  [[groupCream]],
)).rows[0]
assert(Number(summaryCream.order_count) === 0, '面霜分组初始无业绩')

const multiInitial = new Map((await db.query(
  `select * from public.get_business_performance_multi_dimension('product_group', null, null, null, null, null, null, null, null)`,
)).rows.map((row) => [row.dimension_1_key, row]))
assert(Number(multiInitial.get(groupMask).sales_amount_usd) === 300, '多维总览分组口径与单维一致（面膜 300 USD）')

const catalogInitial = (await db.query(
  `select * from public.get_business_performance_by_product('catalog', null, null, null, null, $1, null)`,
  [[groupMask]],
)).rows
assert(catalogInitial.length === 1 && catalogInitial[0].product_key === `catalog:${productMask}`,
  '产品 tab 按分组筛选返回普通产品')

// 普通产品改分组：历史订单业绩随之迁移
await db.exec('reset role')
await db.exec(`update public.products set group_id = '${groupCream}' where id = '${productMask}'`)
await db.exec('set role authenticated')

const afterCatalogMove = await byGroup()
assert(amount(afterCatalogMove, groupMask, 'order_total_cny') === 1400, '普通产品改分组后原分组只剩定制产品行（面膜 1400 CNY）')
assert(amount(afterCatalogMove, groupCream, 'order_total_cny') === 700, '普通产品历史业绩迁入新分组（面霜 700 CNY）')
assert(amount(afterCatalogMove, '', 'order_total_cny') === 350, '未分组桶不受普通产品改分组影响')

// 定制产品改分组：新增版本后，钉在旧版本上的历史订单行也跟随最新版本
await db.exec('reset role')
await db.exec(`
  insert into public.business_custom_product_versions (
    id, custom_product_id, version_no, code, name, unit,
    default_unit_price, default_currency, product_group_id, created_by
  ) values (
    '${customV2}', '${customProduct}', 2, 'C-0102-V2', '定制面膜', 'pcs',
    40, 'USD', '${groupCream}', '${adminId}'
  );
`)
await db.exec('set role authenticated')

const afterCustomMove = await byGroup()
assert(!afterCustomMove.has(groupMask), '定制产品新版本改分组后原分组不再出现')
assert(amount(afterCustomMove, groupCream, 'order_total_cny') === 2100, '定制产品历史订单行跟随最新版本分组（面霜 2100 CNY）')
assert(Number(afterCustomMove.get(groupCream).order_count) === 1, '同一订单两行合并后订单数仍为 1')

const pinnedVersion = (await db.query(
  `select custom_product_version_id from public.business_order_items where order_id = '${orderMixed}' and source_type = 'custom'`,
)).rows[0]
assert(pinnedVersion.custom_product_version_id === customV1, '订单行仍钉在下单时的定制版本上')

const filtered = await byGroup([groupCream])
assert(filtered.size === 1 && filtered.has(groupCream), 'p_product_group_ids 按实时分组筛选只返回面霜')

const summaryAfter = (await db.query(
  `select * from public.get_business_performance_summary(null, null, null, null, $1, null)`,
  [[groupMask]],
)).rows[0]
assert(Number(summaryAfter.order_count) === 0, '改分组后汇总卡筛选不再命中原分组')

const multiAfter = new Map((await db.query(
  `select * from public.get_business_performance_multi_dimension('product_group', null, null, null, null, null, null, $1, null)`,
  [[groupCream]],
)).rows.map((row) => [row.dimension_1_key, row]))
assert(multiAfter.size === 1 && Number(multiAfter.get(groupCream).sales_amount_usd) === 300,
  '多维总览筛选与实时分组口径一致')

const catalogAfter = (await db.query(
  `select * from public.get_business_performance_by_product('catalog', null, null, null, null, $1, null)`,
  [[groupMask]],
)).rows
assert(catalogAfter.length === 0, '产品 tab 按旧分组筛选不再返回已改分组的普通产品')

const customAfter = (await db.query(
  `select * from public.get_business_performance_by_product('custom', null, null, null, null, $1, null)`,
  [[groupCream]],
)).rows
assert(customAfter.length === 1 && customAfter[0].product_key === `custom:${customProduct}`,
  '产品 tab 定制产品按最新版本分组命中新分组')

await db.exec('reset role')
for (const signature of [
  'public.get_business_performance_summary(date, date, uuid[], uuid[], uuid[], text[])',
  'public.get_business_performance_by_group_base(text, date, date, uuid[], uuid[], uuid[], text[])',
  'public.get_business_performance_by_product(text, date, date, uuid[], uuid[], uuid[], text[])',
  'public.get_business_performance_multi_dimension(text, text, text, date, date, uuid[], uuid[], uuid[], text[])',
]) {
  const acl = (await db.query(
    `select has_function_privilege('authenticated', $1, 'execute') as authed,
            has_function_privilege('anon', $1, 'execute') as anonymous`,
    [signature],
  )).rows[0]
  assert(acl.authed === true && acl.anonymous === false, `执行权限正确：${signature}`)
}

await db.close()
console.log('VERIFY PASS 0102')
