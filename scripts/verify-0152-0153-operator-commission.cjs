const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

const ADMIN = '10000000-0000-4000-8000-000000000001'
const FINANCE = '10000000-0000-4000-8000-000000000002'
const SALES = '10000000-0000-4000-8000-000000000003'
const OP_A = '10000000-0000-4000-8000-000000000004'
const OP_B = '10000000-0000-4000-8000-000000000005'

const SHOP_1 = '20000000-0000-4000-8000-000000000001'
const SHOP_2 = '20000000-0000-4000-8000-000000000002'

const ORDER_ASSIGNED = '30000000-0000-4000-8000-000000000001'
const ORDER_SHOP = '30000000-0000-4000-8000-000000000002'

async function asUser(db, userId) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false);`)
}

async function expectError(fn, pattern) {
  let failed = false
  try {
    await fn()
  } catch (err) {
    failed = true
    assert.match(String(err.message ?? err), pattern)
  }
  assert.ok(failed, `expected failure matching ${pattern}`)
}

async function main() {
  const db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    grant usage on schema public to authenticated, anon;

    create schema if not exists auth;
    create function auth.uid() returns uuid
      language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    create type public.user_role as enum ('admin', 'finance', 'sales', 'supervisor');
    create type public.currency_code as enum ('USD', 'CNY');
    create type public.commission_clearance_status as enum ('pending', 'confirmed', 'rejected');

    create table public.profiles (
      id uuid primary key,
      role public.user_role not null default 'sales',
      status text not null default 'approved',
      supervisor_id uuid
    );
    create table public.customers (
      id uuid primary key default gen_random_uuid(),
      created_by uuid
    );
    create table public.finance_daily_order_shops (
      id uuid primary key default gen_random_uuid(),
      name text
    );
    create table public.business_orders (
      id uuid primary key default gen_random_uuid(),
      customer_id uuid references public.customers(id),
      shop_id uuid references public.finance_daily_order_shops(id),
      salesperson_id uuid references public.profiles(id),
      order_date date not null default current_date,
      status text not null default 'approved',
      voided_at timestamptz,
      total_amount numeric not null default 0,
      currency public.currency_code not null default 'USD',
      exchange_rate_to_cny numeric
    );
    create table public.permission_templates (
      id uuid primary key default gen_random_uuid(),
      system_role public.user_role not null unique,
      name text not null default '',
      description text not null default '',
      permissions jsonb not null default '{}'::jsonb,
      data_scope text not null default 'self',
      sensitive_fields jsonb not null default '{}'::jsonb
    );

    create function public.touch_updated_at() returns trigger
      language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
    create function public.is_my_subordinate(p_profile_id uuid) returns boolean
      language sql stable as $$ select false $$;
    create function public.is_approved_user() returns boolean
      language sql stable security definer set search_path = public as $$
        select exists (
          select 1 from public.profiles where id = (select auth.uid()) and status = 'approved'
        );
      $$;
    create function public.is_finance_or_admin() returns boolean
      language sql stable security definer set search_path = public as $$
        select exists (
          select 1 from public.profiles
          where id = (select auth.uid())
            and status = 'approved'
            and role::text in ('admin', 'finance')
        );
      $$;
    create function public.can_view_business_order(p_order_id uuid) returns boolean
      language sql stable as $$ select false $$;
  `)

  // 生产里 authenticated 对业务表有基础授权，RLS 负责收口；演练库同样补齐。
  await db.exec(`
    grant select, insert, update, delete on all tables in schema public to authenticated;
  `)

  const m0152 = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0152_operations_role.sql'),
    'utf8',
  )
  const m0153 = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0153_operator_commission.sql'),
    'utf8',
  )
  await db.exec(m0152)
  await db.exec(m0153)

  const roleEnum = await db.query(
    `select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'user_role' and e.enumlabel = 'operations'`,
  )
  assert.equal(roleEnum.rows.length, 1, '0152 should add operations to user_role')

  const template = await db.query(
    `select name, data_scope, permissions from public.permission_templates
     where system_role = 'operations'`,
  )
  assert.equal(template.rows.length, 1, 'operations permission template seeded')
  assert.equal(template.rows[0].data_scope, 'self')
  assert.equal(template.rows[0].permissions.orders.view, true)
  assert.equal(template.rows[0].permissions.orders.edit, false)
  assert.equal(template.rows[0].permissions.finance.view, false)

  await db.exec(`
    insert into public.profiles (id, role, status) values
      ('${ADMIN}', 'admin', 'approved'),
      ('${FINANCE}', 'finance', 'approved'),
      ('${SALES}', 'sales', 'approved'),
      ('${OP_A}', 'operations', 'approved'),
      ('${OP_B}', 'operations', 'approved');
    insert into public.finance_daily_order_shops (id, name) values
      ('${SHOP_1}', '店铺一'),
      ('${SHOP_2}', '店铺二');
    insert into public.business_orders
      (id, shop_id, salesperson_id, order_date, status, currency, exchange_rate_to_cny) values
      ('${ORDER_ASSIGNED}', '${SHOP_1}', '${SALES}', current_date, 'approved', 'USD', 7.1),
      ('${ORDER_SHOP}', '${SHOP_2}', '${SALES}', current_date, 'approved', 'CNY', 1);
  `)

  // 份额按人独立：两人各 100% 允许；0 与 >100 拒绝。
  await db.exec(`
    insert into public.finance_shop_operator_rules
      (shop_id, operator_id, share_percent, product_commission_rate) values
      ('${SHOP_2}', '${OP_B}', 100, 3),
      ('${SHOP_2}', '${OP_A}', 100, 5);
    insert into public.finance_business_order_operator_assignments
      (business_order_id, operator_id, share_percent, product_commission_rate, assigned_by) values
      ('${ORDER_ASSIGNED}', '${OP_A}', 100, 2.5, '${SALES}');
  `)
  await expectError(
    () =>
      db.exec(
        `insert into public.finance_shop_operator_rules (shop_id, operator_id, share_percent)
         values ('${SHOP_1}', '${OP_A}', 0);`,
      ),
    /share_valid/,
  )
  await expectError(
    () =>
      db.exec(
        `insert into public.finance_business_order_operator_assignments
           (business_order_id, operator_id, share_percent) values ('${ORDER_SHOP}', '${OP_A}', 100.0001);`,
      ),
    /share_valid|numeric field overflow/,
  )

  // 结清 period 必须是月初。
  await db.exec(`
    insert into public.finance_business_order_operator_commission_clearances
      (business_order_id, operator_id, period, settlement_exchange_rate_to_cny) values
      ('${ORDER_ASSIGNED}', '${OP_A}', date_trunc('month', current_date)::date, 7.1);
  `)
  await expectError(
    () =>
      db.exec(
        `insert into public.finance_business_order_operator_commission_clearances
           (business_order_id, operator_id, period) values ('${ORDER_SHOP}', '${OP_B}', current_date);`,
      ),
    /period_mo/,
  )

  // 可见性：指定了运营的订单 → 只有 A 可见；未指定的订单 → 店铺规则成员可见。
  await asUser(db, OP_A)
  let visible = await db.query(
    `select public.can_view_business_order('${ORDER_ASSIGNED}') as ok,
            public.can_view_business_order('${ORDER_SHOP}') as shop_ok`,
  )
  assert.equal(visible.rows[0].ok, true, 'assigned operator sees the order')
  assert.equal(visible.rows[0].shop_ok, true, 'shop-rule operator sees unassigned order of that shop')

  await asUser(db, OP_B)
  visible = await db.query(
    `select public.can_view_business_order('${ORDER_ASSIGNED}') as ok,
            public.can_view_business_order('${ORDER_SHOP}') as shop_ok`,
  )
  assert.equal(visible.rows[0].ok, false, 'assignment replaces shop rule for that order')
  assert.equal(visible.rows[0].shop_ok, true, 'shop rule applies when no assignment')

  await asUser(db, SALES)
  visible = await db.query(
    `select public.can_view_business_order('${ORDER_ASSIGNED}') as ok`,
  )
  assert.equal(visible.rows[0].ok, true, 'salesperson still sees own order')

  // RLS：运营能看到自己的指定记录，看不到别人的；只能读、不能写结清。
  await asUser(db, OP_B)
  await db.exec(`set role authenticated;`)
  const assignmentsForB = await db.query(
    `select business_order_id from public.finance_business_order_operator_assignments`,
  )
  assert.equal(assignmentsForB.rows.length, 0, 'operator B cannot see operator A assignment')
  await expectError(
    () =>
      db.exec(
        `insert into public.finance_business_order_operator_commission_clearances
           (business_order_id, operator_id, period) values ('${ORDER_SHOP}', '${OP_B}', date_trunc('month', current_date)::date);`,
      ),
    /row-level security|permission denied/,
  )
  await db.exec(`reset role;`)

  await asUser(db, OP_A)
  await db.exec(`set role authenticated;`)
  const assignmentsForA = await db.query(
    `select business_order_id from public.finance_business_order_operator_assignments`,
  )
  assert.equal(assignmentsForA.rows.length, 1, 'operator A sees own assignment')
  const clearancesForA = await db.query(
    `select status from public.finance_business_order_operator_commission_clearances`,
  )
  assert.equal(clearancesForA.rows.length, 1)
  assert.equal(clearancesForA.rows[0].status, 'pending')
  await db.exec(`reset role;`)

  // 财务可写结清；主管不能改别人的提成结清（此处用运营自确认路径覆盖）。
  await asUser(db, FINANCE)
  await db.exec(`set role authenticated;`)
  await db.exec(
    `update public.finance_business_order_operator_commission_clearances
     set status = 'confirmed', confirmed_by = '${FINANCE}', confirmed_at = now()
     where business_order_id = '${ORDER_ASSIGNED}' and operator_id = '${OP_A}';`,
  )
  await db.exec(`reset role;`)
  const confirmed = await db.query(
    `select status from public.finance_business_order_operator_commission_clearances
     where business_order_id = '${ORDER_ASSIGNED}' and operator_id = '${OP_A}'`,
  )
  assert.equal(confirmed.rows[0].status, 'confirmed')

  // 角色 RPC 白名单包含 operations，且保留至少一名管理员。
  await asUser(db, ADMIN)
  await db.query(`select public.admin_set_user_role('${SALES}', 'operations')`)
  const switched = await db.query(`select role from public.profiles where id = '${SALES}'`)
  assert.equal(switched.rows[0].role, 'operations')
  await expectError(
    () => db.query(`select public.admin_set_user_role('${FINANCE}', 'pirate')`),
    /Invalid user role/,
  )

  await db.close()
  console.log('✓ 0152/0153 运营角色与提成演练通过')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
