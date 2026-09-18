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

const migration = '0056_finance_summary_exclude_voided_orders.sql'
if (files.at(-1) !== migration) throw new Error('FAIL 0056 is not the latest migration')
await apply(migration)
console.log('PASS 0056 is idempotent')

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
const financeId = '22222222-2222-4222-8222-222222222222'
const salesId = '33333333-3333-4333-8333-333333333333'
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const customerId = '44444444-4444-4444-8444-444444444444'
const transferId = '55555555-5555-4555-8555-555555555555'
const proofId = '66666666-6666-4666-8666-666666666666'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values
    ('${adminId}', 'admin@example.com'),
    ('${financeId}', 'finance@example.com'),
    ('${salesId}', 'sales@example.com');
  update public.profiles set role='admin', status='approved', full_name='Admin' where id='${adminId}';
  update public.profiles set role='finance', status='approved', full_name='Finance' where id='${financeId}';
  update public.profiles set role='sales', status='approved', full_name='Sales' where id='${salesId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  insert into public.products (id, sku, name, unit, unit_price, currency) values
    ('${productId}', 'SKU-0056', '0056 Product', 'pcs', 10, 'USD');
  insert into public.customers (id, name, created_by) values
    ('${customerId}', '0056 Customer', '${salesId}');
`)

await setUser(adminId)
const shopId = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0056 Shop', null, true,
    array['${adminId}', '${salesId}']::uuid[], 'USD'::public.currency_code
  )
`)

const items = JSON.stringify([
  {
    product_id: productId,
    quantity: 1,
    unit_price: 10,
    daily_shipping_category: 'stock',
    product_received_amount: 10,
    product_received_overridden: false,
    logistics_fee_amount: 0,
    sales_total_amount: 10,
    sales_total_overridden: false,
  },
])
const order = (
  await db.query(`
    select * from public.create_business_order_v5(
      '${customerId}', '2026-09-18', 'stock'::public.business_fulfillment_type,
      'USD'::public.currency_code, 7.2, 0, null, null,
      '${items}'::jsonb, null, '${shopId}', '${salesId}', 'V5-0056', null, null,
      'full'::public.daily_order_payment_category, 10, false, 0, false, 10, false,
      null, null
    )
  `)
).rows[0]
assert(!!order?.id, 'admin creates the live-order fixture')

await asSuperuser()
await db.exec(`
  insert into public.business_customer_transfers (
    id, customer_id, currency, amount, exchange_rate_to_cny, received_at,
    payment_type, proof_path, created_by
  ) values (
    '${transferId}', '${customerId}', 'USD', 10, 7.2, now(),
    'balance', '${salesId}/customer/${customerId}/${proofId}.jpg', '${salesId}'
  );
`)

await setUser(financeId)
let income = Number(await scalar('select income from public.get_finance_summary()'))
assert(income === 0, 'an unallocated customer transfer is not counted as order income')

await asSuperuser()
await db.exec(`
  insert into public.business_order_payment_allocations (
    transfer_id, order_id, amount, payment_type, created_by
  ) values ('${transferId}', '${order.id}', 10, 'balance', '${salesId}');
`)
await setUser(financeId)
income = Number(await scalar('select income from public.get_finance_summary()'))
assert(income === 72, 'an active allocation to a live order is counted as order income')

await setUser(adminId)
await db.query(`
  select public.void_business_order(
    '${order.id}', ${order.version}, '0056 summary regression', 'void-0056-summary'
  )
`)
await setUser(financeId)
income = Number(await scalar('select income from public.get_finance_summary()'))
assert(income === 0, 'voiding the only order removes its allocated transfer from income')
assert(
  Number(await scalar(`
    select count(*)::int from public.business_order_payment_allocations
    where order_id='${order.id}' and voided_at is null
  `)) === 0,
  'voiding the order voids its active allocation',
)

const definition = String(await scalar(`
  select pg_get_functiondef('public.get_finance_summary()'::regprocedure)
`))
assert(
  definition.toLowerCase().includes('bo.voided_at is null'),
  'the summary excludes voided orders from business revenue, costs, and wages',
)

console.log('ALL 0056 CHECKS PASSED')
await db.close()
