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

const migration = '0107_sync_custom_fulfillment_by_items.sql'
if (files.at(-1) !== migration) throw new Error(`FAIL ${migration} is not the latest migration`)
await apply(migration)
console.log('PASS 0107 is idempotent')

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
  await db.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`)
  await db.exec('set role authenticated')
}

async function asSuper() {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', '', false)`)
  await db.query(`select set_config('request.jwt.claim.role', '', false)`)
}

assert(
  (await scalar(
    `select count(*)::int from pg_trigger
     where tgrelid = 'public.business_order_items'::regclass
       and tgname = 'trg_business_order_items_sync_fulfillment' and not tgisinternal`,
  )) === 1,
  '0107 creates the item sync trigger',
)
assert(
  (await scalar(
    `select count(*)::int from pg_proc where proname = 'sync_business_order_fulfillment_type'`,
  )) === 1,
  '0107 creates the sync function',
)

const adminId = '11111111-1111-4111-8111-111111111111'
const salesId = '33333333-3333-4333-8333-333333333333'
const customerId = '22222222-2222-4222-8222-222222222221'
const productId = '66666666-6666-4666-8666-666666666661'

await asSuper()
await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values
    ('${adminId}', 'admin@example.com'),
    ('${salesId}', 'sales@example.com');
  update public.profiles set role='admin', status='approved', full_name='Admin' where id='${adminId}';
  update public.profiles set role='sales', status='approved', full_name='Sales' where id='${salesId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  insert into public.customers (id, name, created_by) values ('${customerId}', '客户甲', '${adminId}');
  insert into public.products (id, sku, name, unit, unit_price, currency, created_by)
    values ('${productId}', 'P-0107-A', '现货产品', '件', 10, 'USD', '${adminId}');
`)

await setUser(adminId)
const shopId = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0107 演练店铺', null, true,
    array['${adminId}','${salesId}']::uuid[], 'USD'::public.currency_code)
`)
assert(Boolean(shopId), 'admin seeds the rehearsal shop')

const item = (category) =>
  JSON.stringify([
    {
      product_id: productId,
      quantity: 5,
      unit_price: 20,
      daily_shipping_category: category,
      product_received_amount: 0,
      product_received_overridden: false,
      logistics_fee_amount: 0,
      sales_total_amount: 0,
      sales_total_overridden: false,
    },
  ])

async function createOrder(label, fulfillmentParam, category) {
  const row = (
    await db.query(
      `select * from public.create_business_order_v4(
        '${customerId}', current_date, '${fulfillmentParam}'::public.business_fulfillment_type,
        'USD', 7, 0, null, null, '${item(category)}'::jsonb, null,
        '${shopId}', '${adminId}', '${label}', current_date, null, 'full',
        0, false, 0, false, 0, false, null)`,
    )
  ).rows[0]
  return row.id
}

const orderFulfillment = (id) => scalar(
  `select fulfillment_type::text from public.business_orders where id='${id}'`,
)

// 建单即验证插入路径：传参为 custom 但明细全现货，触发器应翻回 stock。
const orderA = await createOrder('EXT-0107-A', 'custom', 'stock')
assert(Boolean(orderA), 'admin creates an all-stock order with a custom fulfillment param')
assert((await orderFulfillment(orderA)) === 'stock', 'all-stock order is flipped back to stock by the trigger')

// 明细含定制行：传参为 stock 也应为定制单（调用方无法再与明细脱钩）。
const orderB = await createOrder('EXT-0107-B', 'stock', 'custom')
assert(Boolean(orderB), 'admin creates an order with a custom shipping category line')
assert((await orderFulfillment(orderB)) === 'custom', 'order with a custom line is a custom order regardless of param')

// 更新路径：定制行改回现货，订单同步翻回现货；再改回定制，订单翻回定制。
await asSuper()
await db.exec(`update public.business_order_items set daily_shipping_category='stock' where order_id='${orderB}'`)
assert((await orderFulfillment(orderB)) === 'stock', 'changing the custom line to stock flips the order to stock')
await db.exec(`update public.business_order_items set daily_shipping_category='custom' where order_id='${orderB}'`)
assert((await orderFulfillment(orderB)) === 'custom', 'changing the line back to custom flips the order to custom')

// 删除路径：删掉唯一定制行后订单翻回现货。
await db.exec(`delete from public.business_order_items where order_id='${orderB}'`)
assert((await orderFulfillment(orderB)) === 'stock', 'deleting the only custom line flips the order to stock')

// 存量修正语句：把手工标记为 custom 但无定制明细的订单改回 stock。
await db.exec('alter table public.business_order_items disable trigger trg_business_order_items_sync_fulfillment')
await db.exec(`update public.business_orders set fulfillment_type='custom' where id='${orderA}'`)
assert((await orderFulfillment(orderA)) === 'custom', 'legacy setup: order forced to custom while trigger is off')
await db.exec(`
  update public.business_orders o
  set fulfillment_type = 'stock'::public.business_fulfillment_type
  where o.fulfillment_type = 'custom'::public.business_fulfillment_type
    and not exists (
      select 1 from public.business_order_items i
      where i.order_id = o.id
        and i.daily_shipping_category = 'custom'
    )
`)
assert((await orderFulfillment(orderA)) === 'stock', 'the 0107 backfill returns a forced-custom stock-only order to stock')
await db.exec('alter table public.business_order_items enable trigger trg_business_order_items_sync_fulfillment')

// 客户口径端到端：仅含定制明细行的订单计入定制订单数。
await setUser(adminId)
const orderC = await createOrder('EXT-0107-C', 'stock', 'custom')
assert((await orderFulfillment(orderC)) === 'custom', 'recreated custom-line order counts again')
await asSuper()
const stats = (
  await db.query(`select * from public.get_customer_order_stats(array['${customerId}']::uuid[])`)
).rows[0]
assert(Number(stats.custom_order_count) === 1, 'get_customer_order_stats reports exactly one custom order for the customer')

console.log('VERIFY PASS 0107')
await db.close()
