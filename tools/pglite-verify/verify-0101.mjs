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

const migration = '0101_allow_late_customer_binding.sql'
if (files.at(-1) !== migration) throw new Error('FAIL 0101 is not the latest migration')
await apply(migration)
console.log('PASS 0101 is idempotent')

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
const customerA = '22222222-2222-4222-8222-222222222221'
const customerB = '22222222-2222-4222-8222-222222222222'
const customerC = '22222222-2222-4222-8222-222222222223'
const order1 = '33333333-3333-4333-8333-333333333331'
const order2 = '33333333-3333-4333-8333-333333333332'
const order3 = '33333333-3333-4333-8333-333333333333'
const transfer1 = '44444444-4444-4444-8444-444444444441'
const transfer2 = '44444444-4444-4444-8444-444444444442'
const transfer3 = '44444444-4444-4444-8444-444444444443'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values ('${adminId}', 'admin@example.com');
  update public.profiles set role='admin', status='approved' where id='${adminId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  insert into public.customers (id, name, created_by) values
    ('${customerA}', 'Customer A', '${adminId}'),
    ('${customerB}', 'Customer B', '${adminId}'),
    ('${customerC}', 'Customer C', '${adminId}');

  insert into public.business_orders (
    id, order_number, customer_id, customer_snapshot, salesperson_id, order_date,
    fulfillment_type, currency, exchange_rate_to_cny, items_subtotal, shipping_fee, total_amount
  ) values
    ('${order1}', 'BIND-0096-1', null, '{}'::jsonb, '${adminId}', current_date, 'stock', 'USD', 1, 100, 0, 100),
    ('${order2}', 'BIND-0096-2', null, '{}'::jsonb, '${adminId}', current_date, 'stock', 'USD', 1, 100, 0, 100),
    ('${order3}', 'BIND-0096-3', '${customerA}', '{"name":"Customer A"}'::jsonb, '${adminId}', current_date, 'stock', 'USD', 1, 100, 0, 100);

  insert into public.business_customer_transfers (
    id, customer_id, order_id, currency, amount, exchange_rate_to_cny,
    received_at, payment_type, proof_path, created_by
  ) values
    ('${transfer1}', null, '${order1}', 'USD', 100, 1, now(), 'full',
     '${adminId}/order/${order1}/${transfer1}.png', '${adminId}'),
    ('${transfer2}', '${customerC}', null, 'USD', 100, 1, now(), 'full',
     '${adminId}/customer/${customerC}/${transfer2}.png', '${adminId}'),
    ('${transfer3}', null, '${order3}', 'USD', 100, 1, now(), 'full',
     '${adminId}/order/${order3}/${transfer3}.png', '${adminId}');

  insert into public.business_order_payment_allocations (
    transfer_id, order_id, amount, payment_type, created_by
  ) values
    ('${transfer1}', '${order1}', 100, 'full', '${adminId}'),
    ('${transfer2}', '${order2}', 100, 'full', '${adminId}'),
    ('${transfer3}', '${order3}', 100, 'full', '${adminId}');
`)

await setUser(adminId)

await db.query(`select * from public.set_business_order_customer('${order1}', '${customerA}')`)
const bound = await db.query(`select customer_id from public.business_orders where id='${order1}'`)
assert(bound.rows[0].customer_id === customerA, 'order-scoped allocations allow late customer binding')

await expectError(
  () => db.query(`select * from public.set_business_order_customer('${order2}', '${customerA}')`),
  /Cannot bind customer different from allocation transfer customer/,
  'binding a customer different from the allocation transfer customer is blocked',
)
await db.query(`select * from public.set_business_order_customer('${order2}', '${customerC}')`)
const matched = await db.query(`select customer_id from public.business_orders where id='${order2}'`)
assert(matched.rows[0].customer_id === customerC, 'binding the allocation transfer customer succeeds')

await expectError(
  () => db.query(`select * from public.set_business_order_customer('${order3}', '${customerB}')`),
  /Cannot change customer after payment allocation or completion/,
  'swapping an already bound customer with active allocations remains blocked',
)
await expectError(
  () => db.query(`select * from public.set_business_order_customer('${order3}', null)`),
  /Cannot change customer after payment allocation or completion/,
  'unbinding a customer with active allocations remains blocked',
)

await db.exec('reset role')
await db.exec(`select set_config('app.customer_purge', 'true', false)`)
await db.exec(`update public.business_orders set customer_id = null where id = '${order3}'`)
const purged = await db.query(`select customer_id from public.business_orders where id='${order3}'`)
assert(purged.rows[0].customer_id === null, '0099 customer purge bypass still detaches a bound customer')
await db.exec(`select set_config('app.customer_purge', '', false)`)
await expectError(
  () => db.exec(`update public.business_orders set customer_id = null where id = '${order1}'`),
  /Cannot change customer after payment allocation or completion/,
  'purge bypass stops applying once the flag is cleared',
)

await db.close()
console.log('VERIFY PASS 0101')
