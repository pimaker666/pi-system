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

const migration = '0063_customer_deletion_and_order_unbind.sql'
if (files.at(-1) !== migration) throw new Error('FAIL 0063 is not the latest migration')
await apply(migration)
console.log('PASS 0063 is idempotent')

await db.exec(`
  grant select, insert, update, delete on public.customers to authenticated;
  grant select, update on public.finance_daily_order_workflows to authenticated;
`)

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`)
  console.log(`PASS ${message}`)
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

async function setUser(userId) {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', '${userId}', false)`)
  await db.exec('set role authenticated')
}

const adminId = '11111111-1111-4111-8111-111111111111'
const customerId = '22222222-2222-4222-8222-222222222222'
const orderId = '33333333-3333-4333-8333-333333333333'
const workflowId = '44444444-4444-4444-8444-444444444444'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values ('${adminId}', 'admin@example.com');
  update public.profiles set role='admin', status='approved' where id='${adminId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  insert into public.customers (id, name, created_by) values ('${customerId}', 'Customer to delete', '${adminId}');
  insert into public.business_orders (
    id, order_number, customer_id, customer_snapshot, salesperson_id, order_date,
    fulfillment_type, currency, exchange_rate_to_cny
  ) values (
    '${orderId}', 'UNBIND-0063', '${customerId}', '{"name":"Customer to delete"}', '${adminId}', current_date,
    'stock', 'USD', 1
  );
  alter table public.finance_daily_order_workflows disable trigger user;
  insert into public.finance_daily_order_workflows (
    id, salesperson_id, salesperson_name_snapshot, order_number,
    customer_id, customer_name_snapshot, status
  ) values (
    '${workflowId}', '${adminId}', 'Admin', 'LEGACY-0063',
    '${customerId}', 'Customer to delete', 'approved'
  );
  alter table public.finance_daily_order_workflows enable trigger user;
`)

await setUser(adminId)
const unbound = await db.query(`select * from public.set_business_order_customer('${orderId}', null)`)
assert(unbound.rows.length === 1, 'admin can unbind an order customer')
const order = await db.query(`select customer_id, customer_snapshot from public.business_orders where id='${orderId}'`)
assert(order.rows[0].customer_id === null, 'unbinding clears the order customer ID')
assert(JSON.stringify(order.rows[0].customer_snapshot) === '{}', 'unbinding clears the order customer snapshot')

await db.query(`delete from public.customers where id='${customerId}'`)
const legacy = await db.query(`select customer_id, customer_name_snapshot from public.finance_daily_order_workflows where id='${workflowId}'`)
assert(legacy.rows[0].customer_id === null, 'customer deletion detaches archived workflow customer')
assert(legacy.rows[0].customer_name_snapshot === 'Customer to delete', 'customer deletion preserves archived workflow name')
await db.exec('reset role')
await expectError(
  () => db.query(`update public.finance_daily_order_workflows set order_number='MUTATED' where id='${workflowId}'`),
  /Legacy daily-order facts are read-only/,
  'archived workflow remains read-only',
)

await db.close()
console.log('VERIFY PASS 0063')
