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

const migration = '0052_allow_legacy_product_detachment.sql'
if (!files.includes(migration)) throw new Error('FAIL 0052 migration is missing from replay')
await apply(migration)
console.log('PASS 0052 is idempotent')

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`)
  console.log(`PASS ${message}`)
}

async function scalar(sql) {
  const result = await db.query(sql)
  return result.rows[0] ? Object.values(result.rows[0])[0] : null
}

async function expectReject(label, operation) {
  try {
    await operation()
  } catch (error) {
    if (!String(error).includes('Legacy daily-order facts are read-only')) {
      throw new Error(`FAIL ${label}: wrong error: ${error}`)
    }
    console.log(`PASS ${label}`)
    return
  }
  throw new Error(`FAIL ${label}: unexpectedly allowed`)
}

const productId = '10000000-0000-4000-8000-000000000001'
const linkedOrderId = '20000000-0000-4000-8000-000000000001'
const retainedProductId = '10000000-0000-4000-8000-000000000002'
const retainedOrderId = '20000000-0000-4000-8000-000000000002'

await db.exec(`
  insert into public.products (id, sku, name) values
    ('${productId}', 'LEGACY-DELETE-1', 'Legacy delete fixture'),
    ('${retainedProductId}', 'LEGACY-DELETE-2', 'Legacy retained fixture');
`)

async function seedLegacyOrder(id, product, number) {
  await db.exec(
    'alter table public.finance_daily_orders disable trigger trg_reject_legacy_daily_order_insert_delete',
  )
  try {
    await db.exec(`
      insert into public.finance_daily_orders (
        id, order_date, shop_name_snapshot, salesperson_name_snapshot,
        order_number, shipping_date, product_id, product_name_snapshot,
        product_sku_snapshot, quantity, sales_unit_price_amount,
        sales_unit_price_currency, product_received_amount,
        product_received_currency, logistics_fee_amount, logistics_fee_currency,
        sales_total_amount, sales_total_currency
      ) values (
        '${id}', '2026-09-17', 'Archived shop', 'Archived salesperson',
        '${number}', '2026-09-18', '${product}', 'Archived product name',
        'ARCHIVED-SKU', 2, 10, 'USD'::public.currency_code, 20,
        'USD'::public.currency_code, 3, 'USD'::public.currency_code,
        23, 'USD'::public.currency_code
      );
    `)
  } finally {
    await db.exec(
      'alter table public.finance_daily_orders enable trigger trg_reject_legacy_daily_order_insert_delete',
    )
  }
}

await seedLegacyOrder(linkedOrderId, productId, 'ARCHIVED-DELETE-1')
await seedLegacyOrder(retainedOrderId, retainedProductId, 'ARCHIVED-DELETE-2')

const snapshotBeforeDelete = await scalar(`
  select (to_jsonb(orders) - 'product_id' - 'updated_at')::text
  from public.finance_daily_orders as orders
  where id = '${linkedOrderId}'
`)

await db.exec(`delete from public.products where id = '${productId}'`)

assert(
  (await scalar(`select product_id from public.finance_daily_orders where id = '${linkedOrderId}'`)) === null,
  'deleting a catalog product clears only its archived daily-order reference',
)
assert(
  (await scalar(`
    select (to_jsonb(orders) - 'product_id' - 'updated_at')::text
    from public.finance_daily_orders as orders
    where id = '${linkedOrderId}'
  `)) === snapshotBeforeDelete,
  'catalog deletion preserves every archived daily-order snapshot field',
)

await expectReject('ordinary archived-order updates remain rejected', () =>
  db.exec(`
    update public.finance_daily_orders
    set product_name_snapshot = 'Tampered'
    where id = '${linkedOrderId}'
  `),
)
await expectReject('manual reference removal while a product exists is rejected', () =>
  db.exec(`
    update public.finance_daily_orders
    set product_id = null
    where id = '${retainedOrderId}'
  `),
)
await expectReject('archived-order inserts remain rejected', () =>
  db.exec(`
    insert into public.finance_daily_orders (
      order_date, shop_name_snapshot, salesperson_name_snapshot,
      order_number, shipping_date, product_name_snapshot, product_sku_snapshot,
      quantity, sales_unit_price_amount, sales_unit_price_currency,
      product_received_amount, product_received_currency, logistics_fee_amount,
      logistics_fee_currency, sales_total_amount, sales_total_currency
    ) values (
      '2026-09-17', 'Shop', 'Salesperson', 'TAMPER-INSERT', '2026-09-18',
      'Name', 'SKU', 1, 1, 'USD'::public.currency_code, 1,
      'USD'::public.currency_code, 0, 'USD'::public.currency_code, 1,
      'USD'::public.currency_code
    )
  `),
)
await expectReject('archived-order deletes remain rejected', () =>
  db.exec(`delete from public.finance_daily_orders where id = '${linkedOrderId}'`),
)
await expectReject('archived-order cascading truncation remains rejected', () =>
  db.exec('truncate public.finance_daily_orders cascade'),
)

assert(
  (await scalar(`
    select count(*)::int
    from pg_catalog.pg_trigger
    where tgrelid = 'public.finance_daily_orders'::regclass
      and not tgisinternal
      and tgname in (
        'trg_reject_legacy_daily_order_insert_delete',
        'trg_reject_legacy_daily_order_update',
        'trg_reject_legacy_daily_order_truncate'
      )
  `)) === 3,
  'daily-order legacy protection is installed as the three expected guards',
)

console.log('ALL 0052 CHECKS PASSED')
await db.close()
