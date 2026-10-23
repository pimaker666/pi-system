import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations')
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

const migration = '0106_transfer_shipment_multi_screenshots.sql'
if (files.at(-1) !== migration) throw new Error(`FAIL ${migration} is not the latest migration`)
await apply(migration)
console.log('PASS 0106 is idempotent')

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`)
  console.log(`PASS ${message}`)
}

async function expectReject(label, operation, expectedMessage) {
  try {
    await operation()
  } catch (error) {
    if (expectedMessage && !String(error.message ?? error).includes(expectedMessage)) {
      throw new Error(`FAIL ${label}: wrong error: ${error}`)
    }
    console.log(`PASS ${label}`)
    return
  }
  throw new Error(`FAIL ${label}: unexpectedly allowed`)
}

async function scalar(sql, params = []) {
  const result = await db.query(sql, params)
  return result.rows[0] ? Object.values(result.rows[0])[0] : null
}

async function rows(sql, params = []) {
  return (await db.query(sql, params)).rows
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

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

assert(
  (await scalar(
    `select count(*)::int from pg_proc where proname = 'record_business_customer_transfer_v2'`,
  )) === 1,
  '0106 keeps a single transfer v2 overload',
)
assert(
  (await scalar(
    `select pronargs::int from pg_proc where proname = 'record_business_customer_transfer_v2'`,
  )) === 13 &&
    (await scalar(
      `select pronargdefaults::int from pg_proc where proname = 'record_business_customer_transfer_v2'`,
    )) === 1,
  'transfer v2 has 13 params with the trailing extras default',
)
assert(
  (await scalar(
    `select count(*)::int from pg_proc where proname = 'create_business_order_shipment_v2'`,
  )) === 1,
  '0106 keeps a single shipment v2 overload',
)
assert(
  (await scalar(
    `select pronargs::int from pg_proc where proname = 'create_business_order_shipment_v2'`,
  )) === 10 &&
    (await scalar(
      `select pronargdefaults::int from pg_proc where proname = 'create_business_order_shipment_v2'`,
    )) === 1,
  'shipment v2 has 10 params with the trailing extras default',
)
assert(
  (await scalar(
    `select is_nullable from information_schema.columns
     where table_schema='public' and table_name='business_customer_transfers'
       and column_name='proof_path'`,
  )) === 'YES',
  '0106 makes transfer proof_path nullable',
)
const tExtraCount = (
  await rows(
    `select count(*)::int as n from information_schema.columns
     where table_schema='public' and table_name='business_customer_transfers'
       and column_name='extra_proof_paths'
       and is_nullable='NO' and column_default like '%::text[]'`,
  )
)[0].n
assert(tExtraCount === 1, 'transfers gain not-null default-empty extra_proof_paths')
assert(
  (
    await rows(
      `select count(*)::int as n from information_schema.columns
       where table_schema='public' and table_name='business_order_shipments'
         and column_name='extra_screenshot_paths'
         and is_nullable='NO' and column_default like '%::text[]'`,
    )
  )[0].n === 1,
  'shipments gain not-null default-empty extra_screenshot_paths',
)

const admin = '11111111-1111-4111-8111-111111111111'
const sales = '33333333-3333-4333-8333-333333333333'
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values
    ('${admin}', 'admin@example.com'),
    ('${sales}', 'sales@example.com');
  update public.profiles set role='admin', status='approved', full_name='Admin' where id='${admin}';
  update public.profiles set role='sales', status='approved', full_name='Sales' where id='${sales}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  insert into public.products (id, sku, name) values ('${productId}', 'SKU-0106', '0106 Product');
`)

await setUser(admin)
const shopUsd = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0106 USD Shop', null, true,
    array['${admin}','${sales}']::uuid[], 'USD'::public.currency_code)
`)
assert(!!shopUsd, 'admin seeds the USD rehearsal shop')

const items = () =>
  JSON.stringify([
    {
      product_id: productId,
      quantity: 20,
      unit_price: 100,
      daily_shipping_category: 'stock',
      product_received_amount: 0,
      product_received_overridden: false,
      logistics_fee_amount: 0,
      sales_total_amount: 0,
      sales_total_overridden: false,
    },
  ])

const orderId = (
  await db.query(`
    select * from public.create_business_order_v4(
      null, current_date, 'stock'::public.business_fulfillment_type,
      'USD'::public.currency_code, 7.2, 0, null, null,
      '${items()}'::jsonb, null, '${shopUsd}', '${sales}', '0106-A',
      current_date, 'SHIP-0106-A', 'full'::public.daily_order_payment_category,
      0, false, 0, false, 0, false, null)
  `)
).rows[0].id
assert(!!orderId, 'admin creates the rehearsal order')
const itemId = await scalar(
  `select id from public.business_order_items where order_id = $1 order by sort_order limit 1`,
  [orderId],
)
// v4 会按明细行金额重算 total_amount/total_sales_amount，演练里清零实收与销售口径，
// 让未收空间 = total_amount(2000) - 0，足以承载测试转账；明细实收同理清零。
await asSuper()
await db.query(
  `update public.business_orders
   set total_product_received_amount = 0, total_sales_amount = 0
   where id = $1`,
  [orderId],
)
await db.query(
  `update public.business_order_items set product_received_amount = 0 where order_id = $1`,
  [orderId],
)

async function seedProof(n) {
  await asSuper()
  const paths = []
  for (let i = 0; i < n; i += 1) {
    const path = `${sales}/order/${orderId}/${randomUUID()}.jpg`
    await db.query(
      `insert into storage.objects(bucket_id, name, owner, metadata)
       values ('business-payment-proofs', $1, $2, '{"mimetype":"image/jpeg","size":"1024"}'::jsonb)`,
      [path, sales],
    )
    paths.push(path)
  }
  return paths
}

async function recordTransfer({ proofPath, extras, key }) {
  await setUser(sales)
  return db.query(`
    select public.record_business_customer_transfer_v2(
      null, '${orderId}', 'USD'::public.currency_code, 10, 7.2, '2026-10-23 12:00:00+00'::timestamptz,
      'balance'::public.business_payment_type,
      ${proofPath === null ? 'null' : `'${proofPath}'`},
      null, null, '${key}',
      '[{"order_id":"${orderId}","allocation_target":"item","order_item_id":"${itemId}","amount":10}]'::jsonb
      ${extras ? `, '${JSON.stringify(extras)}'::jsonb` : ''}
    ) as result
  `)
}

async function transferRow(key) {
  return (
    await rows(
      `select proof_path, extra_proof_paths
       from public.business_customer_transfers where idempotency_key = $1`,
      [key],
    )
  )[0]
}

// T1. 旧式 12 参调用 + 凭证留空：转账成功落空凭证（0106 放开可选）。
await recordTransfer({ proofPath: null, extras: null, key: 'IDEM-0106-NULL' })
let transfer = await transferRow('IDEM-0106-NULL')
assert(
  transfer.proof_path === null && transfer.extra_proof_paths.length === 0,
  'a 12-arg transfer without any proof persists null proof and empty extras',
)

// T2. 空白凭证字符串同样按未上传处理。
await recordTransfer({ proofPath: '   ', extras: null, key: 'IDEM-0106-BLANK' })
transfer = await transferRow('IDEM-0106-BLANK')
assert(transfer.proof_path === null, 'a blank proof_path is normalized to null')

// T3. 首图 + 2 张附加凭证：落库并返回完整数组。
const [t3Proof, ...t3ExtrasSeeds] = await seedProof(3)
const t3Extras = t3ExtrasSeeds.slice(0, 2)
const t3Result = (
  await recordTransfer({ proofPath: t3Proof, extras: t3Extras, key: 'IDEM-0106-EXTRAS' })
).rows[0].result
transfer = await transferRow('IDEM-0106-EXTRAS')
assert(
  transfer.proof_path === t3Proof && transfer.extra_proof_paths.length === 2,
  'a transfer with two extra proofs persists both arrays',
)
assert(
  JSON.stringify(t3Result.transfer.extra_proof_paths) === JSON.stringify(t3Extras),
  'the rpc result carries extra_proof_paths',
)

// T4. 幂等重放：同 key 同载荷（含附加凭证数组）返回缓存结果。
await recordTransfer({ proofPath: t3Proof, extras: t3Extras, key: 'IDEM-0106-EXTRAS' })
assert(
  (await scalar(
    `select count(*)::int from public.business_customer_transfers where idempotency_key = $1`,
    ['IDEM-0106-EXTRAS'],
  )) === 1,
  'replaying the same extras payload keeps a single transfer row',
)

// T5. 同 key 不同附加凭证：幂等冲突。
await expectReject(
  'the same idempotency key with different extras is rejected',
  () => recordTransfer({ proofPath: t3Proof, extras: [t3Extras[0]], key: 'IDEM-0106-EXTRAS' }),
  'Idempotency key was already used with a different payload',
)

// T6. 附加凭证 uid 前缀不属当前用户。
const foreignPath = `44444444-4444-4444-8444-444444444444/order/${orderId}/${randomUUID()}.jpg`
await expectReject(
  'an extra proof owned by another user is rejected',
  () => recordTransfer({ proofPath: t3Proof, extras: [foreignPath], key: 'IDEM-0106-FOREIGN' }),
  'Invalid transfer proof path',
)

// T7. 附加凭证不是数组。
await expectReject(
  'a non-array extras payload is rejected',
  () => recordTransfer({ proofPath: t3Proof, extras: { path: 'x' }, key: 'IDEM-0106-OBJ' }),
  'Invalid transfer proof path',
)

// T8. 附加凭证与首图重复。
await expectReject(
  'an extra proof duplicating the first proof is rejected',
  () => recordTransfer({ proofPath: t3Proof, extras: [t3Proof], key: 'IDEM-0106-DUP' }),
  'Invalid transfer proof path',
)

// T9. 附加凭证在 storage 中不存在。
await expectReject(
  'an extra proof without a storage object is rejected',
  () =>
    recordTransfer({
      proofPath: t3Proof,
      extras: [`${sales}/order/${orderId}/${randomUUID()}.jpg`],
      key: 'IDEM-0106-MISSING',
    }),
  'Transfer proof object does not exist',
)

// T10. 首图 + 9 张附加 = 合计 10 张，允许。
const t10Proof = (await seedProof(1))[0]
const t10Extras = await seedProof(9)
await recordTransfer({ proofPath: t10Proof, extras: t10Extras, key: 'IDEM-0106-TEN' })
transfer = await transferRow('IDEM-0106-TEN')
assert(
  transfer.extra_proof_paths.length === 9,
  'a transfer with nine extra proofs (10 total) is accepted',
)

// T11. 首图 + 10 张附加 = 合计 11 张，拒绝。
const t11Proof = (await seedProof(1))[0]
const t11Extras = await seedProof(10)
await expectReject(
  'an eleventh extra proof is rejected',
  () => recordTransfer({ proofPath: t11Proof, extras: t11Extras, key: 'IDEM-0106-ELEVEN' }),
  'Transfer cannot have more than 10 proof images',
)

// S. 发货批次截图多张。
await setUser(admin)
assert(
  (await scalar(`select public.has_current_permission('orders.ship')`)) === true,
  'admin passes the orders.ship permission gate',
)

const shipmentPath = () => `${admin}/${orderId}/${randomUUID()}.jpg`

async function createShipment({ screenshotPath, extras, key }) {
  await setUser(admin)
  return db.query(`
    select public.create_business_order_shipment_v2(
      '${orderId}', now() - interval '1 hour', null, null,
      '[{"order_item_id":"${itemId}","quantity":1}]'::jsonb,
      '${key}', false, null
      ${screenshotPath ? `, '${screenshotPath}'` : ', null'}
      ${extras ? `, '${JSON.stringify(extras)}'::jsonb` : ''}
    ) as result
  `)
}

async function shipmentRow(key) {
  await asSuper()
  return (
    await rows(
      `select s.screenshot_path, s.extra_screenshot_paths
       from public.business_order_shipments s
       join public.business_rpc_idempotency i
         on i.operation = 'create_business_order_shipment'
        and i.idempotency_key = $1
       where s.id = (i.result -> 'shipment' ->> 'id')::uuid`,
      [key],
    )
  )[0]
}

// S1. 旧式 9 参调用：无截图照常创建。
await createShipment({ screenshotPath: null, extras: null, key: 'IDEM-0106-SHIP-1' })
let shipment = await shipmentRow('IDEM-0106-SHIP-1')
assert(
  shipment.screenshot_path === null && shipment.extra_screenshot_paths.length === 0,
  'a legacy 9-arg shipment call still works with empty screenshots',
)

// S2. 首图 + 2 张附加：结果与行都带数组。
const s2Shot = shipmentPath()
const s2Extras = [shipmentPath(), shipmentPath()]
const s2Result = (
  await createShipment({ screenshotPath: s2Shot, extras: s2Extras, key: 'IDEM-0106-SHIP-2' })
).rows[0].result
shipment = await shipmentRow('IDEM-0106-SHIP-2')
assert(
  shipment.screenshot_path === s2Shot && shipment.extra_screenshot_paths.length === 2,
  'a shipment with two extra screenshots persists both arrays',
)
assert(
  JSON.stringify(s2Result.shipment.extra_screenshot_paths) === JSON.stringify(s2Extras),
  'the shipment rpc result carries extra_screenshot_paths',
)

// S3. 附加截图 uid 不属当前用户。
await expectReject(
  'an extra shipment screenshot owned by another user is rejected',
  () =>
    createShipment({
      screenshotPath: s2Shot,
      extras: [`44444444-4444-4444-8444-444444444444/${orderId}/${randomUUID()}.jpg`],
      key: 'IDEM-0106-SHIP-FOREIGN',
    }),
  'Invalid shipment screenshot path',
)

// S4. 附加截图不是数组。
await expectReject(
  'a non-array shipment extras payload is rejected',
  () =>
    createShipment({
      screenshotPath: s2Shot,
      extras: { path: 'x' },
      key: 'IDEM-0106-SHIP-OBJ',
    }),
  'Invalid shipment screenshot path',
)

// S5. 附加截图与首图重复。
await expectReject(
  'an extra shipment screenshot duplicating the first one is rejected',
  () =>
    createShipment({
      screenshotPath: s2Shot,
      extras: [s2Shot],
      key: 'IDEM-0106-SHIP-DUP',
    }),
  'Invalid shipment screenshot path',
)

// S6. 首图 + 9 张附加 = 合计 10 张，允许。
const s6Shot = shipmentPath()
const s6Extras = Array.from({ length: 9 }, () => shipmentPath())
await createShipment({ screenshotPath: s6Shot, extras: s6Extras, key: 'IDEM-0106-SHIP-TEN' })
shipment = await shipmentRow('IDEM-0106-SHIP-TEN')
assert(
  shipment.extra_screenshot_paths.length === 9,
  'a shipment with nine extra screenshots (10 total) is accepted',
)

// S7. 首图 + 10 张附加 = 合计 11 张，拒绝。
const s7Extras = Array.from({ length: 10 }, () => shipmentPath())
await expectReject(
  'an eleventh shipment screenshot is rejected',
  () =>
    createShipment({
      screenshotPath: shipmentPath(),
      extras: s7Extras,
      key: 'IDEM-0106-SHIP-ELEVEN',
    }),
  'Shipment cannot have more than 10 screenshot images',
)

await db.close()
console.log('VERIFY PASS 0106')
