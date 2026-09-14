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

const quote = (value) =>
  value === null || value === undefined ? 'null' : `'${String(value).replaceAll("'", "''")}'`
const num = (value) => (value === null || value === undefined ? null : Number(value))

assert(files.at(-1) === '0041_order_scoped_transfers_and_ledger_totals.sql', '0041 is the latest migration')
assert(
  (await scalar(
    `select count(*)::int from pg_proc where proname = 'record_business_customer_transfer_v2'`,
  )) === 1,
  '0041 defines the order-scoped transfer RPC',
)
assert(
  (await scalar(
    `select is_nullable from information_schema.columns
     where table_schema='public' and table_name='business_customer_transfers'
       and column_name='customer_id'`,
  )) === 'YES',
  '0041 permits a null transfer customer for order scope',
)

const admin = '11111111-1111-4111-8111-111111111111'
const finance = '22222222-2222-4222-8222-222222222222'
const sales = '33333333-3333-4333-8333-333333333333'
const otherSales = '44444444-4444-4444-8444-444444444444'
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const proofId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const partialProofId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const foreignProofId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const badProofId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values
    ('${admin}', 'admin@example.com'),
    ('${finance}', 'finance@example.com'),
    ('${sales}', 'sales@example.com'),
    ('${otherSales}', 'other-sales@example.com');
  update public.profiles set role='admin', status='approved', full_name='Admin' where id='${admin}';
  update public.profiles set role='finance', status='approved', full_name='Finance' where id='${finance}';
  update public.profiles set role='sales', status='approved', full_name='Sales' where id='${sales}';
  update public.profiles set role='sales', status='approved', full_name='Other Sales' where id='${otherSales}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  insert into public.products (id, sku, name) values ('${productId}', 'SKU-0041', '0041 Product');
`)

await setUser(finance)
const shopId = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0041 USD Shop', null, true,
    array['${admin}','${sales}','${otherSales}']::uuid[], 'USD'::public.currency_code)
`)
assert(!!shopId, 'finance seeds a shop for order-scoped transfer rehearsal')

function items(receivedProduct = 40) {
  return JSON.stringify([
    {
      product_id: productId,
      quantity: 2,
      unit_price: 100,
      daily_shipping_category: 'stock',
      product_received_amount: receivedProduct,
      product_received_overridden: true,
      logistics_fee_amount: 0,
      sales_total_amount: receivedProduct,
      sales_total_overridden: true,
    },
  ])
}

async function createNoCustomerOrder({ salespersonId, label }) {
  await setUser(admin)
  const result = await db.query(`
    select * from public.create_business_order_v4(
      null, current_date, 'stock'::public.business_fulfillment_type,
      'USD'::public.currency_code, 7.2, 0, null, null,
      '${items()}'::jsonb, null, '${shopId}', '${salespersonId}', '0041-${label}',
      current_date, 'SHIP-${label}', 'full'::public.daily_order_payment_category,
      40, true, 0, true, 40, true, null)
  `)
  return result.rows[0].id
}

const targetOrderId = await createNoCustomerOrder({ salespersonId: sales, label: 'TARGET' })
const otherOrderId = await createNoCustomerOrder({ salespersonId: otherSales, label: 'OTHER' })
assert(!!targetOrderId && !!otherOrderId, 'admin creates customer-less orders for distinct salespeople')

async function seedProof(fileId, orderId) {
  await asSuper()
  const path = `${sales}/order/${orderId}/${fileId}.jpg`
  await db.exec(`
    insert into storage.objects(bucket_id, name, owner, metadata)
    values (
      'business-payment-proofs', '${path}', '${sales}',
      '{"mimetype":"image/jpeg","size":"1024"}'::jsonb
    )
  `)
  return path
}

const proofPath = await seedProof(proofId, targetOrderId)
await setUser(sales)
await db.query(`
  select public.record_business_customer_transfer_v2(
    null, '${targetOrderId}', 'USD'::public.currency_code, 60, 7.2, now(),
    'balance'::public.business_payment_type, '${proofPath}', null, null,
    'IDEM-0041-OK', '[{"order_id":"${targetOrderId}","amount":60}]'::jsonb)
`)

await asSuper()
const transfer = (
  await rows(`
    select customer_id, order_id, amount
    from public.business_customer_transfers
    where idempotency_key='IDEM-0041-OK'
  `)
)[0]
assert(
  transfer.customer_id === null && transfer.order_id === targetOrderId && num(transfer.amount) === 60,
  'order-scoped transfer persists without a customer and retains its order scope',
)
assert(
  (await scalar(`
    select count(*)::int
    from public.business_order_payment_allocations a
    join public.business_customer_transfers t on t.id = a.transfer_id
    where t.idempotency_key='IDEM-0041-OK'
      and a.order_id='${targetOrderId}'
      and a.amount=60
      and a.voided_at is null
  `)) === 1,
  'order-scoped transfer creates one full allocation to its own order',
)

const partialProofPath = await seedProof(partialProofId, targetOrderId)
await setUser(sales)
await expectReject(
  'an order-scoped transfer cannot leave an unallocated balance',
  () =>
    db.query(`
      select public.record_business_customer_transfer_v2(
        null, '${targetOrderId}', 'USD'::public.currency_code, 10, 7.2, now(),
        'balance'::public.business_payment_type, '${partialProofPath}', null, null,
        'IDEM-0041-PARTIAL', '[{"order_id":"${targetOrderId}","amount":9}]'::jsonb)
    `),
  'Order transfer must be fully allocated to its own order',
)

const foreignProofPath = await seedProof(foreignProofId, targetOrderId)
await setUser(sales)
await expectReject(
  'an order-scoped transfer cannot allocate to another order',
  () =>
    db.query(`
      select public.record_business_customer_transfer_v2(
        null, '${targetOrderId}', 'USD'::public.currency_code, 10, 7.2, now(),
        'balance'::public.business_payment_type, '${foreignProofPath}', null, null,
        'IDEM-0041-FOREIGN', '[{"order_id":"${otherOrderId}","amount":10}]'::jsonb)
    `),
  'Order transfer can only be allocated to its own order',
)

await setUser(sales)
await expectReject(
  'an order-scoped transfer requires its order proof namespace',
  () =>
    db.query(`
      select public.record_business_customer_transfer_v2(
        null, '${targetOrderId}', 'USD'::public.currency_code, 10, 7.2, now(),
        'balance'::public.business_payment_type,
        '${sales}/order/${otherOrderId}/${badProofId}.jpg', null, null,
        'IDEM-0041-BAD-PROOF', '[{"order_id":"${targetOrderId}","amount":10}]'::jsonb)
    `),
  'Invalid transfer proof path',
)

await setUser(sales)
const visibleBalances = await rows(`
  select * from public.get_business_orders_outstanding_amount(
    array['${targetOrderId}', '${otherOrderId}']::uuid[]
  )
`)
assert(
  visibleBalances.length === 1 &&
    visibleBalances[0].order_id === targetOrderId &&
    num(visibleBalances[0].outstanding_amount) === 100,
  'the outstanding-balance RPC combines entry receipts and transfers, then filters invisible orders',
)

await setUser(admin)
const adminBalances = await rows(`
  select * from public.get_business_orders_outstanding_amount(
    array['${targetOrderId}', '${otherOrderId}']::uuid[]
  ) order by order_id
`)
const balanceByOrder = new Map(adminBalances.map((row) => [row.order_id, num(row.outstanding_amount)]))
assert(
  balanceByOrder.get(targetOrderId) === 100 && balanceByOrder.get(otherOrderId) === 160,
  'the outstanding-balance RPC uses total amount minus entry receipts and active allocations',
)

console.log('ALL 0041 CHECKS PASSED')
await db.close()
