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

const migration = '0055_business_order_item_settlements.sql'
if (!files.includes(migration)) throw new Error('FAIL 0055 migration is missing from replay')
await apply(migration)
console.log('PASS 0055 is idempotent')

await db.exec(`
  grant usage on schema public to anon, authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant usage, select on all sequences in schema public to authenticated;
  grant select, insert, update, delete on public.products to authenticated;
`)

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
    if (message && !String(error).includes(message)) {
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

async function asSuperuser() {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub', '', false)")
}

const adminId = '11111111-1111-4111-8111-111111111111'
const financeId = '22222222-2222-4222-8222-222222222222'
const salesId = '33333333-3333-4333-8333-333333333333'
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const customerId = '44444444-4444-4444-8444-444444444444'

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
    ('${productId}', 'SKU-0055', '0055 Product', 'pcs', 10, 'USD');
  insert into public.customers (id, name, created_by) values
    ('${customerId}', '0055 Customer', '${salesId}');
`)

await setUser(adminId)
const shopId = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0055 Shop', null, true,
    array['${adminId}', '${salesId}']::uuid[], 'USD'::public.currency_code
  )
`)
assert(!!shopId, 'admin creates the daily-order shop fixture')

function itemJson() {
  return {
    product_id: productId,
    quantity: 2,
    unit_price: 10,
    daily_shipping_category: 'stock',
    product_received_amount: 20,
    product_received_overridden: false,
    logistics_fee_amount: 0,
    sales_total_amount: 20,
    sales_total_overridden: false,
  }
}

async function createOrder(label) {
  const items = [itemJson()]
  const amount = 20
  const result = await db.query(`
    select * from public.create_business_order_v5(
      '${customerId}', '2026-09-17', 'stock'::public.business_fulfillment_type,
      'USD'::public.currency_code, 7.2, 0, null, null,
      '${JSON.stringify(items)}'::jsonb, null,
      '${shopId}', '${salesId}', '${label}', null, null,
      'full'::public.daily_order_payment_category, ${amount}, false, 0, false, ${amount}, false,
      null, null
    )
  `)
  return result.rows[0]
}

const orderA = await createOrder('V5-0055-A')
const orderB = await createOrder('V5-0055-B')
assert(!!orderA?.id && !!orderB?.id, 'admin creates two approved business orders')
assert(
  ['approved', 'completed'].includes(
    await scalar(`select status from public.business_orders where id='${orderA.id}'`),
  ),
  'admin-created orders are auto-approved (settlement gate precondition)',
)

const itemA = await scalar(
  `select id from public.business_order_items where order_id='${orderA.id}' limit 1`,
)
const itemB = await scalar(
  `select id from public.business_order_items where order_id='${orderB.id}' limit 1`,
)
assert(!!itemA && !!itemB, 'both orders have a settleable item line')

// ---------------------------------------------------------------------------
// 1. period 必须是当月第一天
// ---------------------------------------------------------------------------
await setUser(financeId)
await expectReject(
  'a non-first-of-month period is rejected by the check constraint',
  () =>
    db.query(`
      insert into public.finance_business_order_item_settlements
        (business_order_item_id, period, unit_cost, quantity, settled_by)
      values ('${itemA}', '2026-09-15', 5, 2, '${financeId}')
    `),
  'finance_business_order_item_settlement_period_month',
)

// ---------------------------------------------------------------------------
// 2. 负数校验
// ---------------------------------------------------------------------------
await expectReject(
  'a negative quantity is rejected',
  () =>
    db.query(`
      insert into public.finance_business_order_item_settlements
        (business_order_item_id, period, unit_cost, quantity, settled_by)
      values ('${itemA}', '2026-09-01', 5, -1, '${financeId}')
    `),
  'finance_business_order_item_settlement_quantity_nonneg',
)
await expectReject(
  'a negative unit_cost is rejected',
  () =>
    db.query(`
      insert into public.finance_business_order_item_settlements
        (business_order_item_id, period, unit_cost, quantity, settled_by)
      values ('${itemA}', '2026-09-01', -5, 2, '${financeId}')
    `),
  'finance_business_order_item_settlement_unit_cost_nonneg',
)

// ---------------------------------------------------------------------------
// 3. 结算人必须是自己
// ---------------------------------------------------------------------------
await expectReject(
  'inserting a settlement attributed to another user is rejected by RLS',
  () =>
    db.query(`
      insert into public.finance_business_order_item_settlements
        (business_order_item_id, period, unit_cost, quantity, settled_by)
      values ('${itemA}', '2026-09-01', 5, 2, '${salesId}')
    `),
  'row-level security',
)

// ---------------------------------------------------------------------------
// 4. finance 结算成功；unit_cost 允许为空（定制产品无目录成本）
// ---------------------------------------------------------------------------
await db.query(`
  insert into public.finance_business_order_item_settlements
    (business_order_item_id, period, unit_cost, quantity, settled_by)
  values ('${itemA}', '2026-09-01', null, 2, '${financeId}')
`)
assert(
  (await scalar(
    `select count(*)::int from public.finance_business_order_item_settlements where business_order_item_id='${itemA}'`,
  )) === 1,
  'finance can settle an item with a null archived unit_cost',
)

// ---------------------------------------------------------------------------
// 5. sales 不能结算（is_finance_or_admin 门禁）
// ---------------------------------------------------------------------------
await setUser(salesId)
await expectReject(
  'a sales user cannot insert a settlement',
  () =>
    db.query(`
      insert into public.finance_business_order_item_settlements
        (business_order_item_id, period, unit_cost, quantity, settled_by)
      values ('${itemB}', '2026-09-01', 5, 2, '${salesId}')
    `),
  'row-level security',
)

// ---------------------------------------------------------------------------
// 6. select 对所有已认证用户开放（台账结算状态列依赖）
// ---------------------------------------------------------------------------
assert(
  (await scalar(
    `select count(*)::int from public.finance_business_order_item_settlements where business_order_item_id='${itemA}'`,
  )) === 1,
  'a sales user can read settlement rows (drives the ledger status column)',
)

// ---------------------------------------------------------------------------
// 7. sales 不能取消结算；finance 可以
// ---------------------------------------------------------------------------
await expectReject(
  'a sales user cannot delete a settlement',
  async () => {
    const result = await db.query(
      `delete from public.finance_business_order_item_settlements where business_order_item_id='${itemA}' returning business_order_item_id`,
    )
    if (result.rows.length === 0) throw new Error('row-level security: delete removed nothing')
  },
  'row-level security',
)

// ---------------------------------------------------------------------------
// 8. 已作废订单不能结算
// ---------------------------------------------------------------------------
await asSuperuser()
await db.exec(`
  select set_config('app.void_business_order_rpc', 'true', false);
  update public.business_orders set voided_at = now(), voided_by = '${financeId}', void_reason = '0055 test' where id='${orderB.id}';
  select set_config('app.void_business_order_rpc', '', false);
`)
await setUser(financeId)
await expectReject(
  'settling an item on a voided order is rejected by RLS',
  () =>
    db.query(`
      insert into public.finance_business_order_item_settlements
        (business_order_item_id, period, unit_cost, quantity, settled_by)
      values ('${itemB}', '2026-09-01', 5, 2, '${financeId}')
    `),
  'row-level security',
)

// finance 取消结算成功。
const deleted = await db.query(
  `delete from public.finance_business_order_item_settlements where business_order_item_id='${itemA}' returning business_order_item_id`,
)
assert(deleted.rows.length === 1, 'finance can cancel (delete) a settlement')

// ---------------------------------------------------------------------------
// 9. 明细行删除级联清理结算记录
// ---------------------------------------------------------------------------
await db.query(`
  insert into public.finance_business_order_item_settlements
    (business_order_item_id, period, unit_cost, quantity, settled_by)
  values ('${itemA}', '2026-09-01', 3, 2, '${financeId}')
`)
await asSuperuser()
await db.query(`delete from public.business_order_items where id='${itemA}'`)
assert(
  (await scalar(
    `select count(*)::int from public.finance_business_order_item_settlements where business_order_item_id='${itemA}'`,
  )) === 0,
  'deleting a business order item cascades to its settlement row',
)

console.log('ALL 0055 CHECKS PASSED')
await db.close()
