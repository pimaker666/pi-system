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

const migration = '0057_business_order_customer_and_shipment_permissions.sql'
if (files.at(-1) !== migration) throw new Error('FAIL 0057 is not the latest migration')
await apply(migration)
console.log('PASS 0057 is idempotent')

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
const supervisorId = '44444444-4444-4444-8444-444444444444'
const otherSalesId = '55555555-5555-4555-8555-555555555555'
const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ownCustomerId = '66666666-6666-4666-8666-666666666666'
const otherCustomerId = '77777777-7777-4777-8777-777777777777'

await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values
    ('${adminId}', 'admin@example.com'),
    ('${financeId}', 'finance@example.com'),
    ('${salesId}', 'sales@example.com'),
    ('${supervisorId}', 'supervisor@example.com'),
    ('${otherSalesId}', 'other-sales@example.com');
  update public.profiles set role='admin', status='approved', full_name='Admin' where id='${adminId}';
  update public.profiles set role='finance', status='approved', full_name='Finance' where id='${financeId}';
  update public.profiles set role='sales', status='approved', full_name='Sales' where id='${salesId}';
  update public.profiles set role='supervisor', status='approved', full_name='Supervisor' where id='${supervisorId}';
  update public.profiles set role='sales', status='approved', full_name='Other Sales' where id='${otherSalesId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;
  insert into public.products (id, sku, name, unit, unit_price, currency) values
    ('${productId}', 'SKU-0057', '0057 Product', 'pcs', 10, 'USD');
  insert into public.customers (id, name, company, created_by) values
    ('${ownCustomerId}', 'Own Customer', 'Own Company', '${salesId}'),
    ('${otherCustomerId}', 'Other Customer', 'Other Company', '${otherSalesId}');
`)

await setUser(adminId)
const shopId = await scalar(`
  select id from public.save_finance_daily_order_shop(
    null, '0057 Shop', null, true,
    array['${adminId}', '${salesId}', '${supervisorId}', '${otherSalesId}']::uuid[],
    'USD'::public.currency_code
  )
`)

const items = JSON.stringify([
  {
    product_id: productId,
    quantity: 2,
    unit_price: 10,
    daily_shipping_category: 'stock',
    product_received_amount: 20,
    product_received_overridden: false,
    logistics_fee_amount: 0,
    sales_total_amount: 20,
    sales_total_overridden: false,
  },
])

async function createOrder(salespersonId, externalNumber) {
  return (
    await db.query(`
      select * from public.create_business_order_v5(
        null, '2026-09-18', 'stock'::public.business_fulfillment_type,
        'USD'::public.currency_code, 7.2, 0, null, null,
        '${items}'::jsonb, null, '${shopId}', '${salespersonId}', '${externalNumber}', null, null,
        'full'::public.daily_order_payment_category, 20, false, 0, false, 20, false,
        null, null
      )
    `)
  ).rows[0]
}

const ownOrder = await createOrder(salesId, '0057-OWN')
const otherOrder = await createOrder(otherSalesId, '0057-OTHER')
const financeShipmentOrder = await createOrder(salesId, '0057-FINANCE-SHIP')
assert(ownOrder?.id && otherOrder?.id && financeShipmentOrder?.id, 'admin creates approved order fixtures')

await setUser(salesId)
const linked = (
  await db.query(`select * from public.set_business_order_customer('${ownOrder.id}', '${ownCustomerId}')`)
).rows[0]
assert(linked?.id === ownOrder.id, 'sales links an owned customer to an owned order')
const linkedOrder = (
  await db.query(`
    select customer_id, customer_snapshot->>'name' as customer_name,
           status::text as status, approval_status, version
    from public.business_orders where id='${ownOrder.id}'
  `)
).rows[0]
assert(linkedOrder.customer_id === ownCustomerId, 'customer_id is updated immediately')
assert(linkedOrder.customer_name === 'Own Customer', 'customer snapshot is synchronized')
assert(linkedOrder.status === 'approved' && linkedOrder.approval_status === 'approved', 'customer linking preserves approval state')
assert(Number(linkedOrder.version) === Number(ownOrder.version) + 1, 'customer linking increments order version')
await asSuperuser()
assert(
  Number(await scalar(`
    select count(*)::int from public.business_order_audit_logs
    where order_id='${ownOrder.id}' and entity_type='order' and action='update'
  `)) >= 1,
  'customer linking writes an order audit record',
)
await setUser(salesId)

await expectError(
  () => db.query(`select * from public.set_business_order_customer('${ownOrder.id}', '${otherCustomerId}')`),
  /Customer does not exist or is not manageable/,
  'sales cannot link another salesperson customer',
)
await expectError(
  () => db.query(`select * from public.set_business_order_customer('${otherOrder.id}', '${ownCustomerId}')`),
  /Sales user cannot set customer for another owner/,
  'sales cannot change another salesperson order',
)

const ownItemId = await scalar(`select id from public.business_order_items where order_id='${ownOrder.id}'`)
const shipmentItems = JSON.stringify([{ order_item_id: ownItemId, quantity: 1 }])
await expectError(
  () => db.query(`
    select public.create_business_order_shipment(
      '${ownOrder.id}', now(), null, null, '${shipmentItems}'::jsonb, 'sales-ship-0057'
    )
  `),
  /Only approved administrators or finance users can create shipments/,
  'sales cannot create shipments',
)

await setUser(supervisorId)
await expectError(
  () => db.query(`
    select public.create_business_order_shipment(
      '${ownOrder.id}', now(), null, null, '${shipmentItems}'::jsonb, 'supervisor-ship-0057'
    )
  `),
  /Only approved administrators or finance users can create shipments/,
  'supervisor cannot create shipments',
)

await setUser(adminId)
const shipment = (
  await db.query(`
    select public.create_business_order_shipment(
      '${ownOrder.id}', now(), null, null, '${shipmentItems}'::jsonb, 'admin-ship-0057'
    ) as result
  `)
).rows[0].result.shipment
assert(!!shipment?.id, 'admin can create shipments')

await setUser(salesId)
await expectError(
  () => db.query(`select public.void_business_order_shipment('${shipment.id}', 'sales denied')`),
  /Only approved administrators or finance users can void shipments/,
  'sales cannot void shipments',
)

await setUser(financeId)
await db.query(`select public.void_business_order_shipment('${shipment.id}', 'finance void')`)
assert(
  Boolean(await scalar(`select voided_at is not null from public.business_order_shipments where id='${shipment.id}'`)),
  'finance can void shipments',
)

const financeItemId = await scalar(`select id from public.business_order_items where order_id='${financeShipmentOrder.id}'`)
const financeShipmentItems = JSON.stringify([{ order_item_id: financeItemId, quantity: 1 }])
const financeShipment = (
  await db.query(`
    select public.create_business_order_shipment(
      '${financeShipmentOrder.id}', now(), null, null,
      '${financeShipmentItems}'::jsonb, 'finance-ship-0057'
    ) as result
  `)
).rows[0].result.shipment
assert(!!financeShipment?.id, 'finance can create shipments')

await db.query(`select * from public.set_business_order_customer('${otherOrder.id}', '${ownCustomerId}')`)
assert(
  (await scalar(`select customer_id from public.business_orders where id='${otherOrder.id}'`)) === ownCustomerId,
  'finance can link any customer to any non-voided order',
)

await asSuperuser()
assert(
  !(await scalar(`
    select has_function_privilege('authenticated',
      'public.create_business_order_shipment_internal_0057(uuid,timestamp with time zone,text,text,jsonb,text,boolean,text)',
      'execute')
  `)),
  'authenticated cannot execute the internal shipment function',
)
assert(
  !(await scalar(`
    select has_function_privilege('authenticated',
      'public.void_business_order_shipment_internal_0057(uuid,text)',
      'execute')
  `)),
  'authenticated cannot execute the internal shipment void function',
)

console.log('ALL 0057 CHECKS PASSED')
await db.close()
