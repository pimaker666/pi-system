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

const migration = '0060_business_order_current_customer_country.sql'
if (files.at(-1) !== migration) throw new Error('FAIL 0060 is not the latest migration')
await apply(migration)
console.log('PASS 0060 is idempotent')

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

const adminId = '11111111-1111-4111-8111-111111111111'
const salesId = '33333333-3333-4333-8333-333333333333'
const otherSalesId = '44444444-4444-4444-8444-444444444444'
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const customerId = '66666666-6666-4666-8666-666666666666'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values
    ('${adminId}', 'admin@example.com'),
    ('${salesId}', 'sales@example.com'),
    ('${otherSalesId}', 'other@example.com');
  update public.profiles set role='admin', status='approved', full_name='Admin' where id='${adminId}';
  update public.profiles set role='sales', status='approved', full_name='Sales' where id='${salesId}';
  update public.profiles set role='sales', status='approved', full_name='Other' where id='${otherSalesId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  insert into public.products (id, sku, name, unit, unit_price, currency) values
    ('${productId}', 'SKU-0060', '0060 Product', 'pcs', 10, 'USD');
  insert into public.customers (id, name, company, country, created_by) values
    ('${customerId}', 'Flag Customer', 'Flag Co', 'USA', '${salesId}');
`)

await setUser(adminId)
const shopId = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0060 Shop', null, true,
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

const linkedOrder = (
  await db.query(`
    select * from public.create_business_order_v5(
      null, '2026-09-18', 'stock'::public.business_fulfillment_type,
      'USD'::public.currency_code, 7.2, 0, null, null,
      '${items}'::jsonb, null, '${shopId}', '${salesId}', '0060-LINKED', null, null,
      'full'::public.daily_order_payment_category, 20, false, 0, false, 20, false,
      null, null
    )
  `)
).rows[0]
const orphanOrder = (
  await db.query(`
    select * from public.create_business_order_v5(
      null, '2026-09-18', 'stock'::public.business_fulfillment_type,
      'USD'::public.currency_code, 7.2, 0, null, null,
      '${items}'::jsonb, null, '${shopId}', '${salesId}', '0060-ORPHAN', null, null,
      'full'::public.daily_order_payment_category, 20, false, 0, false, 20, false,
      null, null
    )
  `)
).rows[0]
assert(linkedOrder?.id && orphanOrder?.id, 'admin creates linked + orphan orders')

await db.query(`select public.set_business_order_customer('${linkedOrder.id}', '${customerId}')`)

// Snapshot freezes the country at link time; now the live customer moves to Japan.
await asSuperuser()
assert(
  (await scalar(
    `select customer_snapshot->>'country' from public.business_orders where id='${linkedOrder.id}'`,
  )) === 'USA',
  'link freezes snapshot country to USA',
)
await db.query(`update public.customers set country='Japan' where id='${customerId}'`)

await setUser(adminId)
const linkedCountry = await scalar(`
  select country from public.get_business_orders_customer_country(
    array['${linkedOrder.id}']::uuid[]
  )
`)
assert(
  linkedCountry === 'Japan',
  `RPC returns the live customer country, not the frozen snapshot (got ${linkedCountry})`,
)

const orphanRows = (
  await db.query(`
    select * from public.get_business_orders_customer_country(
      array['${orphanOrder.id}']::uuid[]
    )
  `)
).rows
assert(orphanRows.length === 0, 'RPC omits orders with no linked customer')

// Visibility is scoped by can_view_business_order: an unrelated salesperson sees nothing.
await setUser(otherSalesId)
const otherVisible = (
  await db.query(`
    select * from public.get_business_orders_customer_country(
      array['${linkedOrder.id}']::uuid[]
    )
  `)
).rows
assert(otherVisible.length === 0, 'unrelated salesperson cannot read the order country')

await setUser(salesId)
const salesCountry = await scalar(`
  select country from public.get_business_orders_customer_country(
    array['${linkedOrder.id}']::uuid[]
  )
`)
assert(salesCountry === 'Japan', 'the owning salesperson reads the live country')

await asSuperuser()
assert(
  !(await scalar(`
    select has_function_privilege('anon',
      'public.get_business_orders_customer_country(uuid[])', 'execute')
  `)),
  'anon cannot execute get_business_orders_customer_country',
)
assert(
  Boolean(await scalar(`
    select has_function_privilege('authenticated',
      'public.get_business_orders_customer_country(uuid[])', 'execute')
  `)),
  'authenticated can execute get_business_orders_customer_country',
)

await expectTooMany()
async function expectTooMany() {
  const many = Array.from({ length: 1001 }, () => 'gen_random_uuid()').join(',')
  try {
    await db.query(`select * from public.get_business_orders_customer_country(array[${many}]::uuid[])`)
  } catch (error) {
    assert(/Too many orders requested/.test(String(error)), 'RPC caps the batch at 1000 ids')
    return
  }
  throw new Error('FAIL RPC accepted more than 1000 ids')
}

console.log('ALL 0060 CHECKS PASSED')
await db.close()
