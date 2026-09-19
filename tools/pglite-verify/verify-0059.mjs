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
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
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

const migration = '0059_customer_remarks_and_order_stats.sql'
if (files.at(-1) !== migration) throw new Error('FAIL 0059 is not the latest migration')
await apply(migration)
console.log('PASS 0059 is idempotent')

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

async function setUser(userId) {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', '${userId}', false)`)
  await db.exec('set role authenticated')
}

async function asSuperuser() {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub', '', false)")
}

async function expectError(operation, pattern, message) {
  try {
    await operation()
  } catch (error) {
    assert(pattern.test(String(error)), message)
    return
  }
  throw new Error(`FAIL ${message}`)
}

// ---- remarks column ----
assert(
  Boolean(await scalar(`
    select 1 from information_schema.columns
    where table_schema='public' and table_name='customers' and column_name='remarks'
  `)),
  'customers.remarks column exists',
)

const adminId = '11111111-1111-4111-8111-111111111111'
const salesId = '33333333-3333-4333-8333-333333333333'
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const customerId = '66666666-6666-4666-8666-666666666666'
const noOrderCustomerId = '88888888-8888-4888-8888-888888888888'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values
    ('${adminId}', 'admin@example.com'),
    ('${salesId}', 'sales@example.com');
  update public.profiles set role='admin', status='approved', full_name='Admin' where id='${adminId}';
  update public.profiles set role='sales', status='approved', full_name='Sales' where id='${salesId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  insert into public.products (id, sku, name, unit, unit_price, currency) values
    ('${productId}', 'SKU-0059', '0059 Product', 'pcs', 10, 'USD');
  insert into public.customers (id, name, company, country, remarks, created_by) values
    ('${customerId}', 'Stats Customer', 'Stats Co', 'USA', '重点客户，偏好蓝色包装', '${salesId}'),
    ('${noOrderCustomerId}', 'Empty Customer', 'Empty Co', 'China', null, '${salesId}');
`)

assert(
  (await scalar(`select remarks from public.customers where id='${customerId}'`)) ===
    '重点客户，偏好蓝色包装',
  'customer remarks persists',
)

await expectError(
  () =>
    db.query(
      `update public.customers set remarks = repeat('x', 2001) where id='${customerId}'`,
    ),
  /customers_remarks_len/,
  'remarks longer than 2000 chars is rejected',
)

await setUser(adminId)
const shopId = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0059 Shop', null, true,
    array['${adminId}', '${salesId}']::uuid[],
    'USD'::public.currency_code
  )
`)

const items = JSON.stringify([
  {
    product_id: productId,
    quantity: 2,
    unit_price: 10,
    daily_shipping_category: 'stock',
    product_received_amount: 20,
    product_received_overridden: false,
    logistics_fee_amount: 0,
    sales_total_amount: 20,
    sales_total_overridden: false,
  },
])

async function createOrder(fulfillment, externalNumber) {
  return (
    await db.query(`
      select * from public.create_business_order_v5(
        null, '2026-09-18', '${fulfillment}'::public.business_fulfillment_type,
        'USD'::public.currency_code, 7.2, 0, null, null,
        '${items}'::jsonb, null, '${shopId}', '${salesId}', '${externalNumber}', null, null,
        'full'::public.daily_order_payment_category, 20, false, 0, false, 20, false,
        null, null
      )
    `)
  ).rows[0]
}

const customOrder = await createOrder('custom', '0059-CUSTOM')
const stockOrder = await createOrder('stock', '0059-STOCK')
assert(customOrder?.id && stockOrder?.id, 'admin creates approved custom + stock orders')

await db.query(`select public.set_business_order_customer('${customOrder.id}', '${customerId}')`)
await db.query(`select public.set_business_order_customer('${stockOrder.id}', '${customerId}')`)

const stats = (
  await db.query(
    `select * from public.get_customer_order_stats(array['${customerId}','${noOrderCustomerId}']::uuid[])`,
  )
).rows
assert(stats.length === 1, 'stats returns a row only for customers with qualifying orders')

const row = stats.find((r) => r.customer_id === customerId)
assert(!!row, 'stats include the customer with orders')
assert(Number(row.custom_order_count) === 1, 'custom_order_count counts only fulfillment_type=custom')
assert(
  Number(row.last_year_amount_cny) === 288,
  `last_year_amount_cny sums total_cny of qualifying orders (got ${row?.last_year_amount_cny})`,
)
assert(
  new Date(row.last_order_date).toISOString().startsWith('2026-09-18'),
  `last_order_date is the max order_date (got ${row?.last_order_date})`,
)

await asSuperuser()
assert(
  !(await scalar(`
    select has_function_privilege('anon',
      'public.get_customer_order_stats(uuid[])', 'execute')
  `)),
  'anon cannot execute get_customer_order_stats',
)
assert(
  Boolean(await scalar(`
    select has_function_privilege('authenticated',
      'public.get_customer_order_stats(uuid[])', 'execute')
  `)),
  'authenticated can execute get_customer_order_stats',
)

console.log('ALL 0059 CHECKS PASSED')
await db.close()
