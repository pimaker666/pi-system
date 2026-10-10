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

const migration = '0099_customer_recycle_bin.sql'
if (files.at(-1) !== migration) throw new Error('FAIL 0099 is not the latest migration')
await apply(migration)
console.log('PASS 0099 is idempotent')

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`)
  console.log(`PASS ${message}`)
}

async function scalar(sql) {
  const result = await db.query(sql)
  return result.rows[0] ? Object.values(result.rows[0])[0] : null
}

async function expectError(operation, pattern, message) {
  try {
    await operation()
  } catch (error) {
    if (!pattern.test(String(error))) {
      throw new Error(`FAIL ${message} :: unexpected error ${String(error).split('\n')[0]}`)
    }
    console.log(`PASS ${message}`)
    return
  }
  throw new Error(`FAIL ${message} :: no error raised`)
}

async function asSuper() {
  await db.exec('reset role')
  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`)
}

async function setUser(userId) {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', '${userId}', false)`)
  await db.exec('set role authenticated')
}

// --- 结构校验 ---
assert(
  (await scalar(
    `select count(*)::int from information_schema.columns
     where table_schema='public' and table_name='customers'
       and column_name in ('deleted_at','deleted_by') and is_nullable='YES'`,
  )) === 2,
  'customers gains nullable deleted_at and deleted_by',
)
assert(
  (await scalar(
    `select count(*)::int from pg_indexes where schemaname='public'
       and indexname='idx_customers_deleted_at'`,
  )) === 1,
  'recycle bin index exists',
)
assert(
  (await scalar(
    `select count(*)::int from pg_trigger where tgname='trg_reject_recycled_business_customer'
       and tgrelid='public.business_orders'::regclass and not tgisinternal`,
  )) === 1,
  'recycled customer bind guard trigger exists',
)
assert(
  (await scalar(
    `select has_function_privilege('authenticated', 'public.soft_delete_customers(uuid[])', 'EXECUTE')
       and has_function_privilege('authenticated', 'public.restore_customers(uuid[])', 'EXECUTE')
       and has_function_privilege('authenticated', 'public.purge_customers(uuid[])', 'EXECUTE')`,
  )) === true,
  'recycle bin RPCs are callable by authenticated',
)
assert(
  (await scalar(
    `select has_function_privilege('anon', 'public.purge_customers(uuid[])', 'EXECUTE')
       or has_function_privilege('anon', 'public.soft_delete_customers(uuid[])', 'EXECUTE')`,
  )) === false,
  'recycle bin RPCs are hidden from anon',
)

// --- 基础数据 ---
const adminId = '11111111-1111-4111-8111-111111111111'
const salesId = '55555555-5555-4555-8555-555555555555'
const otherSalesId = '66666666-6666-4666-8666-666666666666'
const ghostId = '70000000-0000-4000-8000-000000000000'

const custVoid = '22222222-2222-4222-8222-222222222222'
const custTransfer = '77777777-7777-4777-8777-777777777777'
const custProduct = '88888888-8888-4888-8888-888888888888'
const custLegacy = '99999999-9999-4999-8999-999999999999'
const custAlloc = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const custBind = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const custOther = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const custKept = '18181818-1818-4818-8818-181818181818'

const orderVoid = '33333333-3333-4333-8333-333333333333'
const orderAlloc = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const orderBind = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const orderKept = '19191919-1919-4919-8919-191919191919'
const workflowId = '44444444-4444-4444-8444-444444444444'
const piId = '15151515-1515-4515-8515-151515151515'
const transferCustomer = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const transferOrder = '12121212-1212-4212-8212-121212121212'
const allocationId = '13131313-1313-4313-8313-131313131313'
const customProductId = '16161616-1616-4616-8616-161616161616'
const proofFile = '14141414-1414-4414-8414-141414141414'
const proofFile2 = '17171717-1717-4717-8717-171717171717'

await asSuper()
await db.exec(`
  alter table public.profiles disable trigger trg_profiles_protect_privileged;
  insert into auth.users (id, email) values
    ('${adminId}', 'admin@example.com'),
    ('${salesId}', 'sales@example.com'),
    ('${otherSalesId}', 'other@example.com');
  update public.profiles set role='admin', status='approved', full_name='Admin' where id='${adminId}';
  update public.profiles set role='sales', status='approved', full_name='Sales' where id='${salesId}';
  update public.profiles set role='sales', status='approved', full_name='Other' where id='${otherSalesId}';
  alter table public.profiles enable trigger trg_profiles_protect_privileged;

  insert into public.customers (id, name, created_by) values
    ('${custVoid}', '待彻底删除客户', '${adminId}'),
    ('${custTransfer}', '有收款转账客户', '${adminId}'),
    ('${custProduct}', '有定制产品客户', '${adminId}'),
    ('${custLegacy}', '遗留每日订单客户', '${adminId}'),
    ('${custAlloc}', '已分摊订单客户', '${adminId}'),
    ('${custBind}', '回收站绑定客户', '${adminId}'),
    ('${custKept}', '保留绑定客户', '${adminId}'),
    ('${custOther}', '他人客户', '${salesId}');

  insert into public.business_orders (
    id, order_number, customer_id, customer_snapshot, salesperson_id, order_date,
    fulfillment_type, currency, exchange_rate_to_cny
  ) values
    ('${orderVoid}', 'RB-0099-VOID', '${custVoid}', '{"name":"待彻底删除客户"}', '${adminId}',
     current_date, 'stock', 'USD', 7.2),
    ('${orderAlloc}', 'RB-0099-ALLOC', '${custAlloc}', '{"name":"已分摊订单客户"}', '${adminId}',
     current_date, 'stock', 'USD', 7.2),
    ('${orderBind}', 'RB-0099-BIND', null, '{}', '${adminId}',
     current_date, 'stock', 'USD', 7.2),
    ('${orderKept}', 'RB-0099-KEEP', '${custKept}', '{"name":"保留绑定客户"}', '${adminId}',
     current_date, 'stock', 'USD', 7.2);

  select set_config('app.void_business_order_rpc', 'true', false);
  update public.business_orders
     set voided_at = now(), voided_by = '${adminId}', void_reason = '演练作废',
         version = version + 1
   where id = '${orderVoid}';
  select set_config('app.void_business_order_rpc', '', false);

  alter table public.proforma_invoices disable trigger user;
  insert into public.proforma_invoices (id, pi_number, customer_id, customer_snapshot, created_by)
  values ('${piId}', 'PI-0099-RB', '${custVoid}', '{"name":"待彻底删除客户"}', '${adminId}');
  alter table public.proforma_invoices enable trigger user;

  alter table public.business_customer_transfers disable trigger user;
  insert into public.business_customer_transfers (
    id, customer_id, currency, amount, exchange_rate_to_cny, received_at,
    payment_type, proof_path, created_by
  ) values (
    '${transferCustomer}', '${custTransfer}', 'USD', 100, 7.2, now(),
    'full', '${adminId}/customer/${custTransfer}/${proofFile}.png', '${adminId}'
  );
  insert into public.business_customer_transfers (
    id, order_id, currency, amount, exchange_rate_to_cny, received_at,
    payment_type, proof_path, created_by
  ) values (
    '${transferOrder}', '${orderAlloc}', 'USD', 200, 7.2, now(),
    'full', '${adminId}/order/${orderAlloc}/${proofFile2}.png', '${adminId}'
  );
  alter table public.business_customer_transfers enable trigger user;

  alter table public.business_order_payment_allocations disable trigger user;
  insert into public.business_order_payment_allocations (
    id, transfer_id, order_id, amount, payment_type, created_by
  ) values ('${allocationId}', '${transferOrder}', '${orderAlloc}', 200, 'full', '${adminId}');
  alter table public.business_order_payment_allocations enable trigger user;

  alter table public.business_custom_products disable trigger user;
  insert into public.business_custom_products (id, customer_id, created_by)
  values ('${customProductId}', '${custProduct}', '${adminId}');
  alter table public.business_custom_products enable trigger user;

  alter table public.finance_daily_order_workflows disable trigger user;
  insert into public.finance_daily_order_workflows (
    id, salesperson_id, salesperson_name_snapshot, order_number,
    customer_id, customer_name_snapshot, status
  ) values (
    '${workflowId}', '${adminId}', 'Admin', 'LEGACY-0099',
    '${custLegacy}', null, 'approved'
  );
  alter table public.finance_daily_order_workflows enable trigger user;

  alter table public.business_lifecycle_audit_logs disable trigger user;
  insert into public.business_lifecycle_audit_logs (
    order_id, customer_id, entity_type, entity_id, action, actor_id, actor_snapshot
  ) values (
    '${orderVoid}', '${custVoid}', 'transfer', '${transferCustomer}', 'void',
    '${adminId}', '{"role":"admin"}'::jsonb
  );
  alter table public.business_lifecycle_audit_logs enable trigger user;
`)

assert(
  (await scalar(
    `select count(*)::int from public.business_orders where id='${orderVoid}' and voided_at is not null`,
  )) === 1,
  'fixture voids the reported-bug order',
)

// --- 1. 权限边界 ---
await setUser(ghostId)
await expectError(
  () => db.query(`select public.soft_delete_customers(array['${custVoid}']::uuid[])`),
  /Approved account required/,
  'account without an approved profile cannot soft delete',
)

await setUser(otherSalesId)
assert(
  (await scalar(`select public.soft_delete_customers(array['${custOther}']::uuid[])`)) === 0,
  'non-owner sales user soft deletes nothing',
)
await asSuper()
assert(
  (await scalar(
    `select count(*)::int from public.customers where id='${custOther}' and deleted_at is null`,
  )) === 1,
  'customer owned by another sales user stays active',
)

// --- 2. 作废订单所属客户可以移入回收站（原报错场景） ---
await setUser(adminId)
assert(
  (await scalar(`select public.soft_delete_customers(array['${custVoid}']::uuid[])`)) === 1,
  'admin moves a customer with a voided order into the recycle bin',
)
await asSuper()
const binned = await db.query(
  `select deleted_at, deleted_by::text from public.customers where id='${custVoid}'`,
)
assert(binned.rows[0].deleted_at !== null, 'recycle bin stamps deleted_at')
assert(binned.rows[0].deleted_by === adminId, 'recycle bin records the deleting user')
assert(
  (await scalar(
    `select count(*)::int from public.business_orders
     where id='${orderVoid}' and customer_id='${custVoid}' and voided_at is not null`,
  )) === 1,
  'soft delete leaves the voided order untouched',
)
await setUser(adminId)
assert(
  (await scalar(`select public.soft_delete_customers(array['${custVoid}']::uuid[])`)) === 0,
  'soft delete is idempotent for an already binned customer',
)

// --- 3. 回收站客户不得再被订单绑定 ---
await setUser(adminId)
await db.query(`select public.soft_delete_customers(array['${custBind}']::uuid[])`)
await expectError(
  () => db.query(`select * from public.set_business_order_customer('${orderBind}', '${custBind}')`),
  /Customer is in the recycle bin and cannot be bound to an order/,
  'a binned customer cannot be bound to an order',
)

// --- 3b. 客户进回收站后，其名下订单保留原绑定仍可编辑 ---
assert(
  (await scalar(`select public.soft_delete_customers(array['${custKept}']::uuid[])`)) === 1,
  'admin bins a customer that an active order is bound to',
)
const kept = await db.query(
  `select * from public.set_business_order_customer('${orderKept}', '${custKept}')`,
)
assert(kept.rows.length === 1, 'order keeps its binned customer when the binding is unchanged')
await expectError(
  () => db.query(`select * from public.set_business_order_customer('${orderKept}', '${custBind}')`),
  /Customer is in the recycle bin and cannot be bound to an order/,
  'switching that order to another binned customer is still rejected',
)
await asSuper()
await db.query(
  `update public.business_orders set sales_notes='保留绑定后可编辑' where id='${orderKept}'`,
)
assert(
  (await scalar(
    `select count(*)::int from public.business_orders
     where id='${orderKept}' and sales_notes='保留绑定后可编辑' and customer_id='${custKept}'`,
  )) === 1,
  'a binned customer does not freeze ordinary edits on its orders',
)
await setUser(adminId)
assert(
  (await scalar(`select public.restore_customers(array['${custBind}']::uuid[])`)) === 1,
  'restoring a binned customer clears the bin state',
)
const rebound = await db.query(
  `select * from public.set_business_order_customer('${orderBind}', '${custBind}')`,
)
assert(rebound.rows.length === 1, 'a restored customer can be bound again')
await asSuper()
assert(
  (await scalar(
    `select count(*)::int from public.customers
     where id='${custBind}' and deleted_at is null and deleted_by is null`,
  )) === 1,
  'restore clears deleted_at and deleted_by',
)

// --- 4. 彻底删除 ---
await setUser(adminId)
assert(
  (await scalar(`select public.purge_customers(array['${custAlloc}']::uuid[])`)) === 0,
  'purge skips customers that are not in the recycle bin',
)
assert(
  (await scalar(`select public.purge_customers(array['${custVoid}']::uuid[])`)) === 1,
  'purge removes a customer whose order is voided',
)
await asSuper()
assert(
  (await scalar(`select count(*)::int from public.customers where id='${custVoid}'`)) === 0,
  'purged customer row is gone',
)
const voidOrder = await db.query(
  `select customer_id, status::text st, order_number, void_reason, version
   from public.business_orders where id='${orderVoid}'`,
)
assert(voidOrder.rows[0].customer_id === null, 'purge detaches the voided order customer')
assert(
  voidOrder.rows[0].st === 'draft' &&
    voidOrder.rows[0].order_number === 'RB-0099-VOID' &&
    voidOrder.rows[0].void_reason === '演练作废',
  'purge preserves every other voided order field',
)
const pi = await db.query(
  `select customer_id, customer_snapshot::text snap from public.proforma_invoices where id='${piId}'`,
)
assert(pi.rows[0].customer_id === null, 'purge detaches the proforma invoice customer')
assert(
  JSON.parse(pi.rows[0].snap).name === '待彻底删除客户',
  'purge keeps the proforma invoice customer snapshot',
)
assert(
  (await scalar(
    `select count(*)::int from public.business_lifecycle_audit_logs
     where customer_id='${custVoid}'`,
  )) === 0,
  'purge detaches lifecycle audit rows instead of deleting them',
)
assert(
  (await scalar(
    `select count(*)::int from public.business_lifecycle_audit_logs
     where order_id='${orderVoid}' and actor_id='${adminId}'`,
  )) === 1,
  'purged customer audit trail keeps order and actor',
)

// --- 5. 已分摊订单的客户也能彻底删除 ---
await setUser(adminId)
assert(
  (await scalar(`select public.soft_delete_customers(array['${custAlloc}']::uuid[])`)) === 1,
  'customer with an allocated order can be binned',
)
assert(
  (await scalar(`select public.purge_customers(array['${custAlloc}']::uuid[])`)) === 1,
  'purge survives the payment allocation guard',
)
await asSuper()
assert(
  (await scalar(
    `select count(*)::int from public.business_orders
     where id='${orderAlloc}' and customer_id is null`,
  )) === 1,
  'purge detaches the allocated order customer',
)
assert(
  (await scalar(
    `select count(*)::int from public.business_order_payment_allocations
     where id='${allocationId}' and voided_at is null`,
  )) === 1,
  'purge keeps the payment allocation active',
)

// --- 6. 账目/资产存在的客户拒绝彻底删除 ---
await setUser(adminId)
await db.query(`select public.soft_delete_customers(array['${custTransfer}']::uuid[])`)
await expectError(
  () => db.query(`select public.purge_customers(array['${custTransfer}']::uuid[])`),
  /客户存在收款转账记录，无法彻底删除/,
  'purge refuses when the customer owns transfers',
)
await db.query(`select public.soft_delete_customers(array['${custProduct}']::uuid[])`)
await expectError(
  () => db.query(`select public.purge_customers(array['${custProduct}']::uuid[])`),
  /客户存在定制产品档案，无法彻底删除/,
  'purge refuses when the customer owns custom products',
)
await asSuper()
assert(
  (await scalar(
    `select count(*)::int from public.customers
     where id in ('${custTransfer}','${custProduct}') and deleted_at is not null`,
  )) === 2,
  'refused purges leave both customers in the recycle bin',
)

// --- 7. 遗留每日订单头：解绑并补名称快照 ---
await setUser(adminId)
assert(
  (await scalar(`select public.soft_delete_customers(array['${custLegacy}']::uuid[])`)) === 1,
  'customer with an archived daily order can be binned',
)
assert(
  (await scalar(`select public.purge_customers(array['${custLegacy}']::uuid[])`)) === 1,
  'purge detaches the archived daily order workflow',
)
await asSuper()
const legacy = await db.query(
  `select customer_id, customer_name_snapshot, status::text st
   from public.finance_daily_order_workflows where id='${workflowId}'`,
)
assert(legacy.rows[0].customer_id === null, 'purge clears the archived workflow customer id')
assert(
  legacy.rows[0].customer_name_snapshot === '遗留每日订单客户',
  'purge backfills the archived workflow customer name',
)
assert(legacy.rows[0].st === 'approved', 'purge keeps the archived workflow status')
await expectError(
  () =>
    db.query(
      `update public.finance_daily_order_workflows set order_number='MUTATED' where id='${workflowId}'`,
    ),
  /Legacy daily-order facts are read-only/,
  'archived workflow stays read-only after the purge',
)

// --- 8. 放行范围收窄：非解绑改动依旧被拒 ---
await expectError(
  () => db.query(`update public.business_orders set sales_notes='篡改' where id='${orderVoid}'`),
  /Voided business order cannot be edited or transitioned/,
  'voided order still rejects ordinary edits',
)
await db.exec(`select set_config('app.customer_purge', 'true', false)`)
await expectError(
  () => db.query(`update public.business_orders set customer_id='${custProduct}' where id='${orderVoid}'`),
  /Voided business order cannot be edited or transitioned/,
  'purge flag does not allow rebinding a voided order',
)
await expectError(
  () => db.query(`update public.business_orders set order_number='RB-0099-HACK' where id='${orderVoid}'`),
  /Voided business order cannot be edited or transitioned/,
  'purge flag does not allow editing other voided order fields',
)
await expectError(
  () => db.query(`update public.business_orders set total_amount=1, items_subtotal=1 where id='${orderAlloc}'`),
  /Cannot change customer after payment allocation or completion|Order total cannot be less than active payment allocations/,
  'purge flag does not weaken the allocation invariants',
)
await db.exec(`select set_config('app.customer_purge', '', false)`)
assert(
  (await scalar(
    `select count(*)::int from public.business_orders
     where id='${orderVoid}' and customer_id is null and order_number='RB-0099-VOID'`,
  )) === 1,
  'voided order is unchanged after the rejected edits',
)

await db.close()
console.log('VERIFY PASS 0099')
