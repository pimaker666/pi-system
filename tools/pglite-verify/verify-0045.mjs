import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const migrationsDir =
  process.env.MIGRATIONS_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations')
const db = new PGlite()

await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create or replace function auth.role() returns text language sql stable as $$
    select case when auth.uid() is null then 'anon' else 'authenticated' end
  $$;
  grant usage on schema auth to authenticated;
  grant execute on function auth.uid() to authenticated;
  grant execute on function auth.role() to authenticated;
  create schema storage;
  create table storage.buckets (
    id text primary key, name text not null, public boolean not null default false,
    file_size_limit bigint, allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets(id), name text not null, owner uuid,
    metadata jsonb
  );
  grant usage on schema storage to authenticated;
  grant select, insert, update, delete on table storage.objects to authenticated;
  alter table storage.objects enable row level security;
  create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$
    select case
      when array_length(string_to_array(name, '/'), 1) > 1
      then (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
      else array[]::text[]
    end
  $$;
  create or replace function public.uuid_generate_v4() returns uuid
  language sql volatile as $$ select gen_random_uuid() $$;
  create schema extensions;
  grant usage on schema extensions to anon, authenticated, service_role;
  create or replace function extensions.digest(p_data text, p_algo text) returns bytea
  language sql immutable as $$
    select case
      when p_algo = 'sha256' then sha256(convert_to(p_data, 'UTF8'))
      when p_algo = 'sha512' then sha512(convert_to(p_data, 'UTF8'))
      else null
    end
  $$;
`)

const files = (await readdir(migrationsDir)).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()
for (const file of files) {
  let sql = await readFile(join(migrationsDir, file), 'utf8')
  sql = sql.replace(/^create extension[^;]+;\s*$/gim, '')
  sql = sql.replace(/create index[^;]*gin_trgm_ops[^;]*;/gis, '')
  await db.exec(sql)
}
console.log(`APPLY PASS ${files.length} migrations`)

await db.exec(`
  grant usage on schema public to anon, authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant usage, select on all sequences in schema public to authenticated;
`)

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`)
  console.log(`PASS ${message}`)
}

async function expectReject(label, operation, expectedMessage) {
  try {
    await operation()
  } catch (error) {
    if (expectedMessage && !String(error).includes(expectedMessage)) {
      throw new Error(`FAIL ${label}: wrong error: ${error}`)
    }
    console.log(`PASS ${label}`)
    return
  }
  throw new Error(`FAIL ${label}: unexpectedly allowed`)
}

async function scalar(sql) {
  const result = await db.query(sql)
  return result.rows[0] ? Object.values(result.rows[0])[0] : null
}

async function rows(sql) {
  return (await db.query(sql)).rows
}

async function setUser(userId) {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', '${userId}', false)`)
  await db.exec('set role authenticated')
}

async function asSuper() {
  await db.exec('reset role')
  await db.query("select set_config('request.jwt.claim.sub', '', false)")
}

const num = (value) => (value === null || value === undefined ? null : Number(value))

assert(
  files.at(-1) === '0045_optional_transfer_exchange_rate.sql',
  '0045 is the latest migration',
)
assert(
  (await scalar(
    `select count(*)::int from pg_proc where proname = 'record_business_customer_transfer_v2'`,
  )) === 1,
  '0045 replaces the transfer RPC in place',
)
assert(
  (await scalar(
    `select is_nullable from information_schema.columns
     where table_schema='public' and table_name='business_customer_transfers'
       and column_name='exchange_rate_to_cny'`,
  )) === 'YES',
  '0045 makes the transfer exchange rate nullable',
)

const admin = '11111111-1111-4111-8111-111111111111'
const finance = '22222222-2222-4222-8222-222222222222'
const sales = '33333333-3333-4333-8333-333333333333'
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values
    ('${admin}', 'admin@example.com'),
    ('${finance}', 'finance@example.com'),
    ('${sales}', 'sales@example.com');
  update public.profiles set role='admin', status='approved', full_name='Admin' where id='${admin}';
  update public.profiles set role='finance', status='approved', full_name='Finance' where id='${finance}';
  update public.profiles set role='sales', status='approved', full_name='Sales' where id='${sales}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  insert into public.products (id, sku, name) values ('${productId}', 'SKU-0045', '0045 Product');
`)

await setUser(finance)
const shopUsd = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0045 USD Shop', null, true,
    array['${admin}','${sales}']::uuid[], 'USD'::public.currency_code)
`)
const shopCny = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0045 CNY Shop', null, true,
    array['${admin}','${sales}']::uuid[], 'CNY'::public.currency_code)
`)
assert(!!shopUsd && !!shopCny, 'finance seeds USD and CNY shops for the rehearsal')

function items() {
  return JSON.stringify([
    {
      product_id: productId,
      quantity: 1,
      unit_price: 100,
      daily_shipping_category: 'stock',
      product_received_amount: 0,
      product_received_overridden: false,
      logistics_fee_amount: 0,
      sales_total_amount: 0,
      sales_total_overridden: false,
    },
  ])
}

async function createOrder({ shop, currency, rate, label }) {
  await setUser(admin)
  const result = await db.query(`
    select * from public.create_business_order_v4(
      null, current_date, 'stock'::public.business_fulfillment_type,
      '${currency}'::public.currency_code, ${rate}, 0, null, null,
      '${items()}'::jsonb, null, '${shop}', '${sales}', '0045-${label}',
      current_date, 'SHIP-${label}', 'full'::public.daily_order_payment_category,
      0, false, 0, false, 0, false, null)
  `)
  return result.rows[0].id
}

const usdOrderId = await createOrder({ shop: shopUsd, currency: 'USD', rate: 7.2, label: 'USD' })
const cnyOrderId = await createOrder({ shop: shopCny, currency: 'CNY', rate: 'null', label: 'CNY' })
assert(!!usdOrderId && !!cnyOrderId, 'admin creates USD and CNY orders without entry receipts')

async function seedProof(orderId) {
  await asSuper()
  const path = `${sales}/order/${orderId}/${randomUUID()}.jpg`
  await db.exec(`
    insert into storage.objects(bucket_id, name, owner, metadata)
    values (
      'business-payment-proofs', '${path}', '${sales}',
      '{"mimetype":"image/jpeg","size":"1024"}'::jsonb
    )
  `)
  return path
}

async function recordTransfer({ orderId, currency, amount, rate, key }) {
  const proofPath = await seedProof(orderId)
  await setUser(sales)
  return db.query(`
    select public.record_business_customer_transfer_v2(
      null, '${orderId}', '${currency}'::public.currency_code, ${amount}, ${rate}, '2026-09-15 12:00:00+00'::timestamptz,
      'balance'::public.business_payment_type, '${proofPath}', null, null,
      '${key}', '[{"order_id":"${orderId}","amount":${amount}}]'::jsonb)
  `)
}

async function transferRow(key) {
  return (
    await rows(`
      select order_id, amount, exchange_rate_to_cny
      from public.business_customer_transfers where idempotency_key='${key}'
    `)
  )[0]
}

// A. 非人民币转账留空汇率：落 NULL，分摊正常生成。
await recordTransfer({ orderId: usdOrderId, currency: 'USD', amount: 60, rate: 'null', key: 'IDEM-0045-NULL' })
await asSuper()
let transfer = await transferRow('IDEM-0045-NULL')
assert(
  transfer.order_id === usdOrderId &&
    num(transfer.amount) === 60 &&
    transfer.exchange_rate_to_cny === null,
  'a USD transfer without a rate persists exchange_rate_to_cny as null',
)
assert(
  (await scalar(`
    select count(*)::int
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    where t.idempotency_key='IDEM-0045-NULL'
      and a.order_id='${usdOrderId}'
      and a.amount=60
      and a.voided_at is null
  `)) === 1,
  'the null-rate transfer still creates its order allocation',
)

// B. 幂等重放：同 key 同载荷（含空汇率）返回缓存结果，不产生第二条。
await setUser(sales)
const replay = (
  await rows(`select public.record_business_customer_transfer_v2(
    null, '${usdOrderId}', 'USD'::public.currency_code, 60, null, '2026-09-15 12:00:00+00'::timestamptz,
    'balance'::public.business_payment_type,
    (select proof_path from public.business_customer_transfers where idempotency_key='IDEM-0045-NULL'),
    null, null, 'IDEM-0045-NULL',
    '[{"order_id":"${usdOrderId}","amount":60}]'::jsonb) as transfer`)
)[0].transfer
assert(
  (await scalar(`select count(*)::int from public.business_customer_transfers where idempotency_key='IDEM-0045-NULL'`)) === 1,
  'replaying the same null-rate payload keeps a single transfer row',
)
assert(
  replay.transfer.idempotency_key === 'IDEM-0045-NULL',
  'the idempotent replay returns the cached transfer result',
)

// C. 人民币口径：留空汇率的转账不参与折算；带汇率照常折算。
await asSuper()
let summary = (await rows(`select * from public.get_finance_summary()`))[0]
assert(
  num(summary.income) === 0,
  'get_finance_summary excludes the null-rate transfer from CNY income',
)
await recordTransfer({ orderId: usdOrderId, currency: 'USD', amount: 10, rate: 7.2, key: 'IDEM-0045-RATED' })
await asSuper()
summary = (await rows(`select * from public.get_finance_summary()`))[0]
assert(
  num(summary.income) === 72,
  'get_finance_summary still converts rated transfers (10 × 7.2 = 72)',
)

// D. 人民币转账留空汇率：按 1 落库。
await recordTransfer({ orderId: cnyOrderId, currency: 'CNY', amount: 30, rate: 'null', key: 'IDEM-0045-CNY' })
await asSuper()
transfer = await transferRow('IDEM-0045-CNY')
assert(
  transfer.order_id === cnyOrderId &&
    num(transfer.amount) === 30 &&
    num(transfer.exchange_rate_to_cny) === 1,
  'a CNY transfer without a rate persists exchange_rate_to_cny as 1',
)

// E. 显式非法汇率照旧拒绝。
await expectReject(
  'a CNY transfer with a rate other than one is still rejected',
  () => recordTransfer({ orderId: cnyOrderId, currency: 'CNY', amount: 5, rate: 2, key: 'IDEM-0045-CNY-BAD' }),
  'CNY exchange rate must equal one',
)
await expectReject(
  'a zero exchange rate is still rejected',
  () => recordTransfer({ orderId: usdOrderId, currency: 'USD', amount: 5, rate: 0, key: 'IDEM-0045-ZERO' }),
  'Exchange rate is invalid',
)
await expectReject(
  'an out-of-range exchange rate is still rejected',
  () => recordTransfer({ orderId: usdOrderId, currency: 'USD', amount: 5, rate: 1000001, key: 'IDEM-0045-HUGE' }),
  'Exchange rate is invalid',
)

console.log('ALL 0045 CHECKS PASSED')
await db.close()
