const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

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

    create type public.user_role as enum ('admin', 'finance', 'sales', 'supervisor', 'operations');
    create type public.currency_code as enum ('USD', 'CNY');
    create type public.commission_clearance_status as enum ('pending', 'confirmed', 'rejected');
    create type public.daily_order_shipping_category as enum
      ('stock', 'sample', 'custom', 'custom_sample', 'purchase');

    create table public.profiles (
      id uuid primary key,
      role public.user_role not null default 'sales',
      status text not null default 'approved'
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
      created_at timestamptz not null default now()
    );
    create table public.business_order_items (
      id uuid primary key default gen_random_uuid(),
      order_id uuid not null references public.business_orders(id) on delete cascade,
      daily_shipping_category public.daily_order_shipping_category
    );

    create table public.finance_customer_commission_tags (
      tag_color text primary key,
      label text not null,
      product_commission_rate numeric(7, 4) not null default 0,
      sort_order integer not null default 0
    );
    create table public.finance_customer_custom_order_commission_rates (
      maximum_custom_order_count integer primary key,
      product_commission_rate numeric(7, 4) not null default 0
    );
    create table public.finance_commission_category_rates (
      category public.daily_order_shipping_category primary key,
      product_commission_rate numeric(7, 4) not null default 0
    );
    create table public.finance_shop_operator_rules (
      id uuid primary key default gen_random_uuid(),
      shop_id uuid not null references public.finance_daily_order_shops(id) on delete cascade,
      operator_id uuid not null references public.profiles(id) on delete cascade,
      share_percent numeric(7, 4) not null default 100,
      product_commission_rate numeric(7, 4) not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (shop_id, operator_id)
    );
    create table public.finance_business_order_operator_assignments (
      id uuid primary key default gen_random_uuid(),
      business_order_id uuid not null references public.business_orders(id) on delete cascade,
      operator_id uuid not null references public.profiles(id) on delete cascade,
      share_percent numeric(7, 4) not null default 100,
      product_commission_rate numeric(7, 4) not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (business_order_id, operator_id)
    );

    create function public.touch_updated_at() returns trigger
      language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
    create function public.is_approved_user() returns boolean
      language sql stable as $$ select true $$;
    create function public.is_finance_or_admin() returns boolean
      language sql stable as $$ select true $$;
  `)
  await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;`)

  // 旧配置先落库，确认 0155 不改动 0154 的播种结果。
  await db.exec(`
    insert into public.finance_customer_commission_tags
      (tag_color, label, product_commission_rate, sort_order) values ('#FF0000', '大客户', 8, 1);
    insert into public.finance_customer_custom_order_commission_rates
      (maximum_custom_order_count, product_commission_rate) values (2, 5);
    insert into public.finance_commission_category_rates
      (category, product_commission_rate) values ('stock', 2);
  `)

  const m0154 = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0154_commission_rules.sql'),
    'utf8',
  )
  const m0155 = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0155_operator_rules_shipping_category.sql'),
    'utf8',
  )
  await db.exec(m0154)
  await db.exec(m0155)

  // ---- 1. 运营规则可带发货分类 -------------------------------------------
  await db.exec(`
    insert into public.finance_commission_rules
      (line, name, priority, shipping_category, product_commission_rate)
    values
      ('operator', '定制单 6%', 10, 'custom', 6),
      ('operator', '现货 2%', 20, 'stock', 2),
      ('operator', '兜底 1%', 900, null, 1);
  `)
  const operatorRows = await db.query(
    `select name, shipping_category from public.finance_commission_rules
     where line = 'operator' order by priority`,
  )
  assert.deepEqual(
    operatorRows.rows.map((row) => [row.name, row.shipping_category]),
    [
      ['定制单 6%', 'custom'],
      ['现货 2%', 'stock'],
      ['兜底 1%', null],
    ],
    'operator rules accept shipping_category',
  )

  // ---- 2. 业务线的分类/定制梯度不受影响 ----------------------------------
  const businessSeeds = await db.query(
    `select count(*)::int as n from public.finance_commission_rules where line = 'business'`,
  )
  assert.equal(businessSeeds.rows[0].n, 3, 'business seeds unchanged')

  // ---- 3. 运营线仍拒绝累计定制订单数 -------------------------------------
  await expectError(
    () =>
      db.exec(`insert into public.finance_commission_rules
                 (line, name, product_commission_rate, custom_order_count_max)
               values ('operator', '运营带定制数', 5, 3);`),
    /line_scope_valid/,
  )

  // ---- 4. 非法发货分类被拒绝 ---------------------------------------------
  await expectError(
    () =>
      db.exec(`insert into public.finance_commission_rules
                 (line, name, product_commission_rate, shipping_category)
               values ('operator', '非法分类', 5, 'whatever');`),
    /shipping_category_valid/,
  )

  // ---- 5. 迁移可重复执行 --------------------------------------------------
  await db.exec(m0155)
  const afterRerun = await db.query(
    `select count(*)::int as n from public.finance_commission_rules where line = 'operator'`,
  )
  assert.equal(afterRerun.rows[0].n, 3, 'rerunning 0155 keeps data')

  console.log('✓ 0155 运营规则发货分类演练通过')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
