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

const migration = '0104_allow_editing_uncompleted_shipped_orders.sql'
if (files.at(-1) !== migration) throw new Error(`FAIL ${migration} is not the latest migration`)
await apply(migration)
console.log('PASS 0104 is idempotent')

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`)
  console.log(`PASS ${message}`)
}

const adminId = '11111111-1111-4111-8111-111111111111'
const salesId = '12111111-1111-4111-8111-111111111112'
const customerId = '22222222-2222-4222-8222-222222222221'
const shopId = '33333333-3333-4333-8333-333333333331'
const productId = '66666666-6666-4666-8666-666666666661'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values
    ('${adminId}', 'admin@example.com'),
    ('${salesId}', 'sales@example.com');
  update public.profiles set role='admin', status='approved' where id='${adminId}';
  update public.profiles set role='sales', status='approved', full_name='业务员甲' where id='${salesId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;

  insert into public.customers (id, name, created_by) values ('${customerId}', '客户甲', '${adminId}');
  insert into public.finance_daily_order_shops (id, name, is_active, created_by)
    values ('${shopId}', '演练店铺', true, '${adminId}');
  insert into public.finance_daily_order_shop_salespeople (shop_id, salesperson_id, is_active, created_by)
    values ('${shopId}', '${adminId}', true, '${adminId}'),
           ('${shopId}', '${salesId}', true, '${adminId}');
  insert into public.products (id, sku, name, unit, unit_price, currency, created_by)
    values ('${productId}', 'P-0104-A', '洁面乳', '瓶', 10, 'USD', '${adminId}');
`)

await db.exec('reset role')
await db.query(`select set_config('request.jwt.claim.sub', '${adminId}', false)`)
await db.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`)
await db.exec('set role authenticated')

const dailyFields = (quantity, unitPrice) => ({
  daily_shipping_category: 'stock',
  product_received_amount: Math.round(quantity * unitPrice * 100) / 100,
  product_received_overridden: false,
  logistics_fee_amount: 0,
  sales_total_amount: Math.round(quantity * unitPrice * 100) / 100,
  sales_total_overridden: false,
})

// 建单即同产品重复两行（需求 1：建单路径放行重复产品）
const created = (await db.query(
  `select * from public.create_business_order_v6(
    $1, current_date, 'stock', 'USD', 7, 0, null, null,
    $2::jsonb, null, $3, $4, 'EXT-0104', current_date, null, 'full',
    150, false, 0, false, 150, false, '', '', null
  )`,
  [
    customerId,
    JSON.stringify([
      { source_type: 'catalog', product_id: productId, quantity: 10, unit_price: 10, ...dailyFields(10, 10) },
      { source_type: 'catalog', product_id: productId, quantity: 5, unit_price: 10, ...dailyFields(5, 10) },
    ]),
    shopId,
    adminId,
  ],
)).rows[0]
assert(Boolean(created?.id), '管理员建单成功且返回订单')
const orderId = created.id

const orderRow = (await db.query(`select * from public.business_orders where id = $1`, [orderId])).rows[0]
assert(orderRow.status === 'approved', '管理员建单直接进入已审核')

const createdItems = (await db.query(
  `select id, quantity, sort_order from public.business_order_items where order_id = $1 order by sort_order`,
  [orderId],
)).rows
assert(createdItems.length === 2, '同一产品建单成功落两行明细')
assert(Number(createdItems[0].quantity) === 10 && Number(createdItems[1].quantity) === 5, '两行重复产品数量分别为 10 与 5')

const shippedItemId = createdItems[0].id
const secondItemId = createdItems[1].id

// 需求 2 场景：订单已有有效发货批次（未完结）
await db.exec('reset role')
const shipmentId = (
  await db.query(
    `insert into public.business_order_shipments (order_id, shipped_at, created_by)
     values ($1, now(), $2) returning id`,
    [orderId, adminId],
  )
).rows[0].id
await db.query(
  `insert into public.business_order_shipment_items (shipment_id, order_item_id, quantity)
   values ($1, $2, 3)`,
  [shipmentId, shippedItemId],
)

const accepts = async (role) =>
  (await db.query(`select public.business_order_accepts_entry_edits($1, $2) as ok`, [orderId, role])).rows[0].ok
assert((await accepts('admin')) === true, '有发货的已审核订单：管理员准入编辑（0104 放宽）')
assert((await accepts('finance')) === true, '有发货的已审核订单：财务准入编辑（0104 放宽）')
assert((await accepts('sales')) === false, '有发货的已审核订单：业务员仍不可编辑')
await db.query(`select set_config('request.jwt.claim.sub', '', false)`)
await db.query(`select set_config('request.jwt.claim.role', '', false)`)
let noLoginBlocked = false
try {
  await db.query(
    `select (public.get_business_order_edit_constraints($1)->>'can_edit_order')::boolean as ok`,
    [orderId],
  )
} catch {
  noLoginBlocked = true
}
assert(noLoginBlocked, '未设登录态时约束 RPC 拒绝访问')

const fullItem = (id, quantity) => ({
  ...(id ? { id } : {}),
  source_type: 'catalog',
  product_id: productId,
  quantity,
  unit_price: 10,
  ...dailyFields(quantity, 10),
})

// 管理员完整编辑器：未动两行 + 新增同产品第三行（重复产品再次添加）
await db.query(`select set_config('request.jwt.claim.sub', '${adminId}', false)`)
await db.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`)
await db.exec('set role authenticated')

const updated = (await db.query(
  `select * from public.update_business_order_v6(
    $1, $2, $3, current_date, 'stock', 'USD', 7, 0, null, null,
    $4::jsonb, null, '', $5, $6, 'EXT-0104', current_date, null, 'full',
    170, false, 0, false, 170, false, '', '', null
  )`,
  [
    orderId,
    created.version,
    customerId,
    JSON.stringify([
      fullItem(shippedItemId, 10),
      fullItem(secondItemId, 5),
      fullItem(null, 2),
    ]),
    shopId,
    adminId,
  ],
)).rows[0]
assert(Boolean(updated?.id) && updated.version === created.version + 1, '管理员成功编辑有发货的已审核订单且版本递增')

// 净发货辅助函数未授权给 authenticated，断言在特权上下文执行
await db.exec('reset role')
const afterItems = (await db.query(
  `select quantity, unit_price, product_received_amount, net from (
     select i.quantity, i.unit_price, i.product_received_amount,
            public.business_order_item_net_shipped(i.id) as net
     from public.business_order_items i where i.order_id = $1 order by i.sort_order
   ) t`,
  [orderId],
)).rows
assert(afterItems.length === 3, '编辑后同产品共三行明细（重复添加落库）')
assert(
  Number(afterItems[0].quantity) === 10 &&
    Number(afterItems[1].quantity) === 5 &&
    Number(afterItems[2].quantity) === 2,
  '原有两行数量保持不变，新增行为 2',
)
assert(Number(afterItems[2].net) === 0, '新增行未发货')
assert(Number(afterItems[0].net) === 3, '已发货行净发货仍为 3')

const afterOrder = (await db.query(`select * from public.business_orders where id = $1`, [orderId])).rows[0]
assert(Number(afterOrder.items_subtotal) === 170 && Number(afterOrder.total_product_received_amount) === 170,
  '明细小计与产品实收合计随新增行更新为 170')

// 保护不变：数量不能低于净发货
await db.query(`select set_config('request.jwt.claim.sub', '${adminId}', false)`)
await db.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`)
await db.exec('set role authenticated')
let belowMinimumError = ''
try {
  await db.query(
    `select * from public.update_business_order_v6(
      $1, $2, $3, current_date, 'stock', 'USD', 7, 0, null, null,
      $4::jsonb, null, '', $5, $6, 'EXT-0104', current_date, null, 'full',
      40, false, 0, false, 40, false, '', '', null
    )`,
    [
      orderId,
      afterOrder.version,
      customerId,
      JSON.stringify([fullItem(shippedItemId, 2), fullItem(secondItemId, 5)]),
      shopId,
      adminId,
    ],
  )
} catch (error) {
  belowMinimumError = String(error.message ?? error)
}
assert(belowMinimumError.includes('less than net shipped'), '已发货行数量低于净发货仍被拒绝')

// 业务员仍不可编辑已审核订单
await db.exec('reset role')
await db.query(`select set_config('request.jwt.claim.sub', '${salesId}', false)`)
await db.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`)
await db.exec('set role authenticated')

let salesError = ''
try {
  await db.query(
    `select * from public.update_business_order_v6(
      $1, $2, $3, current_date, 'stock', 'USD', 7, 0, null, null,
      $4::jsonb, null, '', $5, $6, 'EXT-0104', current_date, null, 'full',
      170, false, 0, false, 170, false, '', '', null
    )`,
    [
      orderId,
      afterOrder.version,
      customerId,
      JSON.stringify([fullItem(shippedItemId, 10), fullItem(secondItemId, 5)]),
      shopId,
      salesId,
    ],
  )
} catch (error) {
  salesError = String(error.message ?? error)
}
assert(salesError.includes('cannot be edited in current status'), '业务员编辑已审核订单仍被拒绝')

await db.close()
console.log('VERIFY PASS 0104')
