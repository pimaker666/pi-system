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
    name text,
    public boolean default false,
    file_size_limit bigint,
    allowed_mime_types text[],
    created_at timestamptz default now()
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets(id),
    name text,
    owner uuid,
    owner_id text,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    metadata jsonb
  );
  create function storage.foldername(name text) returns text[] language sql immutable as $$
    select string_to_array(name, '/')
  $$;
  create function extensions.digest(data text, type text) returns bytea language sql immutable as $$
    select public.digest(data, type)
  $$;
`)

const files = (await readdir(migrationsDir)).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()

async function apply(file) {
  await db.exec(await readFile(join(migrationsDir, file), 'utf8'))
}

for (const file of files) await apply(file)
console.log(`APPLY PASS ${files.length} migrations`)

const migration = '0062_restrict_product_status_changes.sql'
if (!files.includes(migration)) throw new Error('FAIL 0062 migration is missing')
await apply(migration)
console.log('PASS 0062 is idempotent')

await db.exec('grant select, insert, update, delete on public.products to authenticated')

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
const financeId = '22222222-2222-4222-8222-222222222222'
const salesId = '33333333-3333-4333-8333-333333333333'
const productId = '44444444-4444-4444-8444-444444444444'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values
    ('${adminId}', 'admin@example.com'),
    ('${financeId}', 'finance@example.com'),
    ('${salesId}', 'sales@example.com');
  update public.profiles set role='admin', status='approved' where id='${adminId}';
  update public.profiles set role='finance', status='approved' where id='${financeId}';
  update public.profiles set role='sales', status='approved' where id='${salesId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  insert into public.products (id, sku, name, unit, unit_price, currency, is_active)
    values ('${productId}', 'STATUS-0062', 'Status guard product', 'pcs', 10, 'USD', true);
`)

await setUser(salesId)
await expectError(
  () => db.query(`update public.products set is_active=false where id='${productId}'`),
  /Approved finance or administrator required to change product status/,
  'sales cannot change product status',
)

await db.query(`update public.products set name='Sales can still edit product' where id='${productId}'`)
assert(
  (await db.query(`select name from public.products where id='${productId}'`)).rows[0].name ===
    'Sales can still edit product',
  'sales can still edit non-status product fields',
)

await setUser(financeId)
await db.query(`update public.products set is_active=false where id='${productId}'`)
assert(
  (await db.query(`select is_active from public.products where id='${productId}'`)).rows[0].is_active === false,
  'finance can deactivate product',
)

await setUser(adminId)
await db.query(`update public.products set is_active=true where id='${productId}'`)
assert(
  (await db.query(`select is_active from public.products where id='${productId}'`)).rows[0].is_active === true,
  'admin can change product status',
)

await db.close()
console.log('VERIFY PASS 0062')
