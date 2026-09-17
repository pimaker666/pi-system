import { PGlite } from '@electric-sql/pglite'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir =
  globalThis.process?.env?.MIGRATIONS_DIR ?? resolve(here, '../../supabase/migrations')
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
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb default '{}'::jsonb
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
  $$;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text not null references storage.buckets(id),
    name text not null,
    owner uuid,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    unique (bucket_id, name)
  );
  create function storage.foldername(name text) returns text[] language sql immutable as $$
    select case
      when strpos(name, '/') = 0 then array[]::text[]
      else string_to_array(regexp_replace(name, '/[^/]+$', ''), '/')
    end
  $$;
`)

const files = (await readdir(migrationsDir)).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()

async function apply(file) {
  let sql = await readFile(join(migrationsDir, file), 'utf8')
  sql = sql
    .replace(/^create extension if not exists .*;\s*$/gim, '')
    .replace(/^create index[^;]*gin_trgm_ops\);\s*$/gim, '')
  await db.exec(sql)
}

for (const file of files) await apply(file)
console.log(`APPLY PASS ${files.length} migrations`)

const migration = '0054_business_order_allow_inactive_catalog_products.sql'
if (!files.includes(migration)) throw new Error('FAIL 0054 migration is missing from replay')
await apply(migration)
console.log('PASS 0054 is idempotent')

// Supabase 的默认表级 grant 不在迁移里，补上 products 的那部分，
// 才能用 authenticated 身份验证"订单内新建产品"所依赖的 products RLS。
await db.exec('grant select, insert, update, delete on public.products to authenticated')

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`)
  console.log(`PASS ${message}`)
}

async function scalar(sql) {
  const result = await db.query(sql)
  return result.rows[0] ? Object.values(result.rows[0])[0] : null
}

async function expectReject(label, operation, message) {
  try {
    await operation()
  } catch (error) {
    if (!String(error).includes(message)) {
      throw new Error(`FAIL ${label}: wrong error: ${error}`)
    }
    console.log(`PASS ${label}`)
    return
  }
  throw new Error(`FAIL ${label}: unexpectedly allowed`)
}

async function setUser(userId) {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', '${userId}', false)`)
  await db.exec('set role authenticated')
}

async function asSuperuser() {
  await db.exec('reset role')
}

const adminId = '11111111-1111-4111-8111-111111111111'
const salesId = '22222222-2222-4222-8222-222222222222'
const activeProductId = '33333333-3333-4333-8333-333333333333'
const customerId = '44444444-4444-4444-8444-444444444444'
const missingProductId = '99999999-9999-4999-8999-999999999999'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values
    ('${adminId}', 'admin@example.com'),
    ('${salesId}', 'sales@example.com');
  update public.profiles set role = 'admin', status = 'approved', full_name = 'Admin'
    where id = '${adminId}';
  update public.profiles set role = 'sales', status = 'approved', full_name = 'Sales'
    where id = '${salesId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  insert into public.products (id, sku, name, unit, unit_price, currency) values
    ('${activeProductId}', 'INACTIVE-OK-ACTIVE', 'Listed base product', 'pcs', 10, 'USD');
  insert into public.customers (id, name, created_by) values
    ('${customerId}', 'Inactive product customer', '${salesId}');
`)

// 下架产品由普通已审批用户直接写入，一并验证 products RLS 足以支撑"订单内新建产品"。
await setUser(salesId)

async function newUnlistedProduct(sku, name) {
  const result = await db.query(`
    insert into public.products (
      sku, name, description, specification, unit, unit_price, currency, is_active, created_by
    ) values (
      '${sku}', '${name}', '${name} desc', '${name} spec', 'box', 12.5, 'USD', false, '${salesId}'
    ) returning id, is_active
  `)
  return result.rows[0]
}

const createProduct = await newUnlistedProduct('INACTIVE-OK-CREATE', 'Unlisted create product')
const editProduct = await newUnlistedProduct('INACTIVE-OK-EDIT', 'Unlisted edit product')
const appendProduct = await newUnlistedProduct('INACTIVE-OK-APPEND', 'Unlisted append product')
assert(
  createProduct.is_active === false &&
    editProduct.is_active === false &&
    appendProduct.is_active === false,
  'an approved user can insert unlisted products through plain products RLS',
)

await setUser(adminId)
const shopId = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, 'Inactive product shop', null, true,
    array['${adminId}', '${salesId}']::uuid[], 'USD'::public.currency_code
  )
`)
assert(!!shopId, 'admin creates the daily-order shop fixture')

function itemJson({ productId, quantity = 2, unitPrice = 10 }) {
  const amount = quantity * unitPrice
  return {
    product_id: productId,
    quantity,
    unit_price: unitPrice,
    daily_shipping_category: 'stock',
    product_received_amount: amount,
    product_received_overridden: false,
    logistics_fee_amount: 0,
    sales_total_amount: amount,
    sales_total_overridden: false,
  }
}

function totals(items) {
  return items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)
}

async function createOrderV5(items, label) {
  const amount = totals(items)
  const result = await db.query(`
    select * from public.create_business_order_v5(
      '${customerId}', '2026-09-17', 'stock'::public.business_fulfillment_type,
      'USD'::public.currency_code, 7.2, 0, null, null,
      '${JSON.stringify(items)}'::jsonb, null,
      '${shopId}', '${salesId}', '${label}', null, null,
      'full'::public.daily_order_payment_category, ${amount}, false, 0, false, ${amount}, false,
      null, null
    )
  `)
  return result.rows[0]
}

async function updateOrderV5(orderId, version, items, reason) {
  const amount = totals(items)
  const result = await db.query(`
    select * from public.update_business_order_v5(
      '${orderId}', ${version}, '${customerId}', '2026-09-17',
      'stock'::public.business_fulfillment_type, 'USD'::public.currency_code,
      7.2, 0, null, null, '${JSON.stringify(items)}'::jsonb, null, '${reason}',
      '${shopId}', '${salesId}', 'V5-INACTIVE', null, null,
      'full'::public.daily_order_payment_category, ${amount}, false, 0, false, ${amount}, false,
      null, null
    )
  `)
  return result.rows[0]
}

async function adjustOrder(orderId, version, items, key) {
  const result = await db.query(`
    select public.adjust_business_order_items(
      '${orderId}', ${version}, '${JSON.stringify(items)}'::jsonb,
      'add_on', '追加下架产品', '${key}'
    ) as payload
  `)
  return result.rows[0].payload
}

// ---------------------------------------------------------------------------
// 1. 建单：可直接选用下架产品
// ---------------------------------------------------------------------------
const order = await createOrderV5(
  [itemJson({ productId: activeProductId }), itemJson({ productId: createProduct.id })],
  'V5-INACTIVE-CREATE',
)
assert(!!order?.id, 'the create path accepts an unlisted catalog product with no extra grant')
assert(
  (await scalar(`
    select count(*)::int from public.business_order_items
    where order_id = '${order.id}' and product_id = '${createProduct.id}'
      and sku_snapshot = 'INACTIVE-OK-CREATE'
      and name_snapshot = 'Unlisted create product'
      and specification_snapshot = 'Unlisted create product spec'
      and unit_snapshot = 'box'
  `)) === 1,
  'the unlisted product is snapshotted onto the order line',
)
assert(
  (await scalar(`select is_active from public.products where id = '${createProduct.id}'`)) === false,
  'using an unlisted product in an order never relists it',
)

await expectReject(
  'a nonexistent product id is still rejected on create',
  () => createOrderV5([itemJson({ productId: missingProductId })], 'V5-INACTIVE-MISSING'),
  'Product does not exist',
)

// ---------------------------------------------------------------------------
// 2. 改单：既有下架行可保留，也可新增下架行
// ---------------------------------------------------------------------------
const keptItems = [
  itemJson({ productId: activeProductId }),
  itemJson({ productId: createProduct.id }),
]
const kept = await updateOrderV5(order.id, order.version, keptItems, '保留下架行')
assert(!!kept?.id, 'an existing unlisted catalog line stays editable')

const grown = await updateOrderV5(
  kept.id,
  kept.version,
  [...keptItems, itemJson({ productId: editProduct.id })],
  '新增下架行',
)
assert(!!grown?.id, 'the edit path accepts a brand-new unlisted catalog line')
assert(
  (await scalar(`
    select count(*)::int from public.business_order_items
    where order_id = '${order.id}' and product_id = '${editProduct.id}'
  `)) === 1,
  'the newly added unlisted product becomes an order line on edit',
)

await expectReject(
  'a nonexistent product id is still rejected on edit',
  () =>
    updateOrderV5(
      grown.id,
      grown.version,
      [...keptItems, itemJson({ productId: missingProductId })],
      '不存在产品',
    ),
  'Product does not exist',
)

// 建单之后才下架：既有行仍可编辑（0038 已有语义的回归检查）。
await asSuperuser()
await db.query(`update public.products set is_active = false where id = '${activeProductId}'`)
await setUser(adminId)
const afterUnlist = await updateOrderV5(grown.id, grown.version, keptItems, '产品事后下架')
assert(!!afterUnlist?.id, 'a line whose product was unlisted after the fact stays editable')
await asSuperuser()
await db.query(`update public.products set is_active = true where id = '${activeProductId}'`)
await setUser(adminId)

// ---------------------------------------------------------------------------
// 3. 追加：可直接追加下架产品
// ---------------------------------------------------------------------------
const appended = await adjustOrder(
  order.id,
  afterUnlist.version,
  [itemJson({ productId: appendProduct.id })],
  'append-inactive-ok',
)
assert(!!appended?.order_id, 'the append path accepts an unlisted catalog product')
assert(
  (await scalar(`
    select count(*)::int from public.business_order_items
    where order_id = '${order.id}' and product_id = '${appendProduct.id}'
      and origin = 'append' and sku_snapshot = 'INACTIVE-OK-APPEND'
  `)) === 1,
  'the appended unlisted product is snapshotted as an appended line',
)

await expectReject(
  'a nonexistent product id is still rejected on append',
  () =>
    adjustOrder(
      order.id,
      appended.version,
      [itemJson({ productId: missingProductId })],
      'append-missing',
    ),
  'Product does not exist',
)

// ---------------------------------------------------------------------------
// 4. 权限与签名边界
// ---------------------------------------------------------------------------
await asSuperuser()
assert(
  (await scalar(`
    select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'replace_business_order_items'
  `)) === 1,
  'replace_business_order_items keeps a single two-argument signature',
)
assert(
  (await scalar(`
    select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'replace_business_order_items'
      and p.prosecdef
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
  `)) === 1,
  'replace_business_order_items stays security-definer and private',
)
assert(
  (await scalar(`
    select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'adjust_business_order_items'
      and p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
  `)) === 1,
  'adjust_business_order_items stays security-definer and authenticated-only',
)
assert(
  (await scalar(`
    select count(*)::int from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'business_order_inactive_product_claims'
  `)) === 0,
  'the abandoned claim-token table was never introduced',
)
assert(
  (await scalar(`
    select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'create_business_order_inactive_product',
        'consume_business_order_inactive_product_claim'
      )
  `)) === 0,
  'the abandoned claim-token RPCs were never introduced',
)

console.log('ALL 0054 CHECKS PASSED')
await db.close()
