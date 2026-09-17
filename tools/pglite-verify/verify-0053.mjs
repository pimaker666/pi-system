import { PGlite } from '@electric-sql/pglite'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = process.env.MIGRATIONS_DIR ?? resolve(here, '../../supabase/migrations')
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

const migration = '0053_business_order_optional_daily_shipping_date.sql'
if (!files.includes(migration)) throw new Error('FAIL 0053 migration is missing from replay')
await apply(migration)
console.log('PASS 0053 is idempotent')

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

const adminId = '11111111-1111-4111-8111-111111111111'
const salesId = '22222222-2222-4222-8222-222222222222'
const productId = '33333333-3333-4333-8333-333333333333'
const customerId = '44444444-4444-4444-8444-444444444444'

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
  insert into public.products (id, sku, name) values
    ('${productId}', 'OPTIONAL-SHIP-DATE', 'Optional shipping date product');
  insert into public.customers (id, name, created_by) values
    ('${customerId}', 'Optional shipping date customer', '${salesId}');
`)

await setUser(adminId)
const shopId = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, 'Optional shipping date shop', null, true,
    array['${adminId}', '${salesId}']::uuid[], 'USD'::public.currency_code
  )
`)
assert(!!shopId, 'admin creates the daily-order shop fixture')

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

function sqlDate(value) {
  return value === null ? 'null' : `'${value}'`
}

async function createOrder(version, label, shippingDate) {
  const baseArgs = `
    '${customerId}', '2026-09-17', 'stock'::public.business_fulfillment_type,
    'USD'::public.currency_code, 7.2, 0, null, null, '${items}'::jsonb, null,
    '${shopId}', '${salesId}', '${label}', ${sqlDate(shippingDate)}, null,
    'full'::public.daily_order_payment_category, 20, false, 0, false, 20, false`
  const args = version === 'v3' ? baseArgs : `${baseArgs}, null, null`
  const result = await db.query(`select * from public.create_business_order_${version}(${args})`)
  return result.rows[0]
}

async function updateV5(orderId, version, shippingDate, reason) {
  const result = await db.query(`
    select * from public.update_business_order_v5(
      '${orderId}', ${version}, '${customerId}', '2026-09-17',
      'stock'::public.business_fulfillment_type, 'USD'::public.currency_code,
      7.2, 0, null, null, '${items}'::jsonb, null, '${reason}', '${shopId}',
      '${salesId}', 'V5-OPTIONAL', ${sqlDate(shippingDate)}, null,
      'full'::public.daily_order_payment_category, 20, false, 0, false, 20, false,
      null, null
    )
  `)
  return result.rows[0]
}

await db.exec('reset role')
await expectReject(
  'V3 retains a required shipping-date contract',
  () => createOrder('v3', 'V3-REJECT', null),
  'Daily shipping date is required',
)
await setUser(adminId)
await expectReject(
  'V4 retains a required shipping-date contract',
  () => createOrder('v4', 'V4-REJECT', null),
  'Daily shipping date is required',
)

const created = await createOrder('v5', 'V5-OPTIONAL', null)
assert(!!created?.id, 'V5 creates an order with no shipping date')
assert(
  (await scalar(`select daily_shipping_date from public.business_orders where id = '${created.id}'`)) === null,
  'V5 persists an omitted shipping date as SQL NULL',
)

const dated = await updateV5(created.id, created.version, '2026-09-20', 'Set shipping date')
assert(
  (await scalar(`select daily_shipping_date::text from public.business_orders where id = '${created.id}'`)) ===
    '2026-09-20',
  'V5 updates the shipping date from NULL to a date',
)
assert(
  (await scalar(`
    select count(*)::int
    from public.business_order_audit_logs
    where order_id = '${created.id}'
      and action = 'update'
      and old_data #>> '{order,daily_shipping_date}' is null
      and new_data #>> '{order,daily_shipping_date}' = '2026-09-20'
  `)) >= 1,
  'the NULL-to-date change is preserved in the order audit',
)

const cleared = await updateV5(dated.id, dated.version, null, 'Clear shipping date')
assert(
  (await scalar(`select daily_shipping_date from public.business_orders where id = '${created.id}'`)) === null,
  'V5 clears the shipping date back to SQL NULL',
)
assert(
  (await scalar(`
    select count(*)::int
    from public.business_order_audit_logs
    where order_id = '${created.id}'
      and action = 'update'
      and old_data #>> '{order,daily_shipping_date}' = '2026-09-20'
      and new_data #>> '{order,daily_shipping_date}' is null
  `)) >= 1,
  'the date-to-NULL change is preserved in the order audit',
)

assert(
  (await scalar(`
    select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_business_order_v5', 'update_business_order_v5')
      and p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
  `)) === 2,
  'V5 RPCs are security-definer and callable only by authenticated users',
)

console.log('ALL 0053 CHECKS PASSED')
await db.close()
