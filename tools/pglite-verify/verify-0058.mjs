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

const migration = '0058_business_order_item_cost_override_row_gate.sql'
if (files.at(-1) !== migration) throw new Error('FAIL 0058 is not the latest migration')
await apply(migration)
console.log('PASS 0058 is idempotent')

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

const adminId = '11111111-1111-4111-8111-111111111111'
const financeId = '22222222-2222-4222-8222-222222222222'
const salesId = '33333333-3333-4333-8333-333333333333'
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

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
    ('${productId}', 'SKU-0058', '0058 Product', 'pcs', 10, 'USD');
`)

await setUser(adminId)
const shopId = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0058 Shop', null, true, array['${adminId}', '${salesId}']::uuid[], 'USD'::public.currency_code
  )
`)

const items = JSON.stringify([
  {
    product_id: productId,
    quantity: 5,
    unit_price: 10,
    daily_shipping_category: 'stock',
    product_received_amount: 50,
    product_received_overridden: false,
    logistics_fee_amount: 0,
    sales_total_amount: 50,
    sales_total_overridden: false,
  },
])

const order = (
  await db.query(`
    select * from public.create_business_order_v5(
      null, '2026-09-18', 'stock'::public.business_fulfillment_type,
      'USD'::public.currency_code, 7.2, 0, null, null,
      '${items}'::jsonb, null, '${shopId}', '${salesId}', '0058-ORDER', null, null,
      'full'::public.daily_order_payment_category, 50, false, 0, false, 50, false,
      null, null
    )
  `)
).rows[0]
assert(!!order?.id, 'admin creates an approved order fixture')

const itemId = await scalar(`select id from public.business_order_items where order_id='${order.id}'`)
const fulfillment = await scalar(`select fulfillment_status::text from public.business_orders where id='${order.id}'`)
assert(fulfillment !== 'fully_shipped', 'order is approved but not fully shipped (no shipment created)')

// Regression: under 0046 this insert was rejected by RLS because the order was
// not fully_shipped. Under 0058 finance can record the cost on the shipped row.
await setUser(financeId)
await db.query(`
  insert into public.finance_business_order_item_cost_overrides (business_order_item_id, cost, updated_by)
  values ('${itemId}', 4, '${financeId}')
`)
assert(
  Number(await scalar(`select cost from public.finance_business_order_item_cost_overrides where business_order_item_id='${itemId}'`)) === 4,
  'finance can save a cost override on an approved order that is not fully shipped',
)

// Role gate is still enforced: a sales user cannot write cost overrides.
await setUser(salesId)
await expectError(
  () => db.query(`
    insert into public.finance_business_order_item_cost_overrides (business_order_item_id, cost, updated_by)
    values ('${itemId}', 9, '${salesId}')
  `),
  /row-level security/i,
  'sales cannot write cost overrides',
)

// Non-approved orders remain blocked even for finance.
await asSuperuser()
await db.query(`update public.business_orders set status='rejected' where id='${order.id}'`)
await setUser(financeId)
await expectError(
  () => db.query(`
    insert into public.finance_business_order_item_cost_overrides (business_order_item_id, cost, updated_by)
    values ('${itemId}', 7, '${financeId}')
    on conflict (business_order_item_id) do update set cost = excluded.cost, updated_by = excluded.updated_by
  `),
  /row-level security/i,
  'finance cannot write cost overrides on a non-approved order',
)

console.log('ALL 0058 CHECKS PASSED')
await db.close()
