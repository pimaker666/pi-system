const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

const C1 = '40000000-0000-4000-8000-000000000001'
const C2 = '40000000-0000-4000-8000-000000000002'

const O_DEAL_1 = '50000000-0000-4000-8000-000000000001'
const O_SAMPLE = '50000000-0000-4000-8000-000000000002'
const O_DEAL_2 = '50000000-0000-4000-8000-000000000003'
const O_DEAL_3 = '50000000-0000-4000-8000-000000000004'
const O_VOIDED = '50000000-0000-4000-8000-000000000005'
const O_PENDING = '50000000-0000-4000-8000-000000000006'
const O_NO_CUSTOMER = '50000000-0000-4000-8000-000000000007'

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

  // 旧配置先落库，验证播种能完整复刻当前优先级链。
  await db.exec(`
    insert into public.finance_customer_commission_tags
      (tag_color, label, product_commission_rate, sort_order) values
      ('#FF0000', '大客户', 8, 2),
      ('#00FF00', '普通', 3, 1);
    insert into public.finance_customer_custom_order_commission_rates
      (maximum_custom_order_count, product_commission_rate) values
      (5, 4),
      (2, 5);
    insert into public.finance_commission_category_rates
      (category, product_commission_rate) values
      ('stock', 2),
      ('custom', 4);
  `)

  const migration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0154_commission_rules.sql'),
    'utf8',
  )
  await db.exec(migration)

  // ---- 1. 播种复刻旧优先级链 ---------------------------------------------
  const seeded = await db.query(
    `select line, name, priority, tag_color, shipping_category, custom_order_count_max,
            product_commission_rate, legacy_source, legacy_key
     from public.finance_commission_rules order by priority, legacy_key`,
  )
  const byKey = new Map(seeded.rows.map((row) => [`${row.legacy_source}:${row.legacy_key}`, row]))
  assert.equal(seeded.rows.length, 6, 'business seeds: 2 tags + 2 tiers + 2 categories')

  const tagHigh = byKey.get('tag:#ff0000')
  assert.ok(tagHigh, 'tag seed uses lowercase colour as legacy key')
  assert.equal(tagHigh.priority, 102, 'tag priority = 100 + sort_order')
  assert.equal(tagHigh.tag_color, '#ff0000', 'tag colour lowercased')
  assert.equal(Number(tagHigh.product_commission_rate), 8)
  assert.equal(byKey.get('tag:#00ff00').priority, 101)

  const tier2 = byKey.get('custom_tier:2')
  const tier5 = byKey.get('custom_tier:5')
  assert.ok(tier2 && tier5, 'custom tier seeds keyed by maximum count')
  assert.equal(tier2.priority, 201, 'tiers ordered by maximum count ascending')
  assert.equal(tier5.priority, 202)
  assert.equal(tier2.shipping_category, 'custom', 'legacy tier keeps custom-only scope')
  assert.equal(tier2.custom_order_count_max, 2)

  const catStock = byKey.get('category:stock')
  assert.ok(catStock, 'category seeds keyed by enum value')
  assert.equal(catStock.priority, 300)
  assert.ok(seeded.rows.every((row) => row.line === 'business'), 'legacy config only seeds business line')

  // ---- 2. 迁移可重复执行（无重复播种）-------------------------------------
  await db.exec(migration)
  const countAfterRerun = await db.query(`select count(*)::int as n from public.finance_commission_rules`)
  assert.equal(countAfterRerun.rows[0].n, 6, 're-running migration must not duplicate seeds')

  // ---- 3. 约束 ------------------------------------------------------------
  await expectError(
    () =>
      db.exec(`insert into public.finance_commission_rules (line, name, product_commission_rate, legacy_source)
               values ('business', '缺键', 1, 'tag');`),
    /legacy_key_valid/,
  )
  await expectError(
    () =>
      db.exec(`insert into public.finance_commission_rules (line, name, product_commission_rate, legacy_source, legacy_key)
               values ('business', '多余键', 1, null, 'x');`),
    /legacy_key_valid/,
  )
  await expectError(
    () =>
      db.exec(`insert into public.finance_commission_rules
                 (line, name, product_commission_rate, shipping_category)
               values ('operator', '运营带分类', 5, 'stock');`),
    /line_scope_valid/,
  )
  await expectError(
    () =>
      db.exec(`insert into public.finance_commission_rules
                 (line, name, product_commission_rate, custom_order_count_max)
               values ('operator', '运营带定制数', 5, 3);`),
    /line_scope_valid/,
  )
  await expectError(
    () =>
      db.exec(`insert into public.finance_commission_rules (line, name, product_commission_rate, order_index_max)
               values ('operator', '首零单', 5, 0);`),
    /order_index_valid/,
  )
  await expectError(
    () =>
      db.exec(`insert into public.finance_commission_rules (line, name, product_commission_rate, tenure_months_max)
               values ('operator', '负年限', 5, -1);`),
    /tenure_valid/,
  )
  await expectError(
    () =>
      db.exec(`insert into public.finance_commission_rules (line, name, product_commission_rate)
               values ('operator', '', 5);`),
    /name/,
  )

  // ---- 4. 两条线独立排序 --------------------------------------------------
  await db.exec(`
    insert into public.finance_commission_rules (line, name, priority, order_index_max, product_commission_rate)
    values
      ('operator', '前 2 单 5%', 1, 2, 5),
      ('operator', '前 10 单 3%', 2, 10, 3),
      ('operator', '兜底 1%', 900, null, 1);
  `)
  // 同 priority 值可同时存在于两条线，互不冲突。
  await db.exec(`
    insert into public.finance_commission_rules (line, name, priority, tag_color, product_commission_rate)
    values ('business', '红色标记 9%', 1, '#ff0000', 9);
  `)
  const perLine = await db.query(
    `select line, name, priority from public.finance_commission_rules
     where line = 'operator' order by priority`,
  )
  assert.deepEqual(
    perLine.rows.map((row) => row.name),
    ['前 2 单 5%', '前 10 单 3%', '兜底 1%'],
    'operator line keeps its own ordering',
  )
  const businessTop = await db.query(
    `select name, priority from public.finance_commission_rules
     where line = 'business' order by priority limit 1`,
  )
  assert.equal(businessTop.rows[0].name, '红色标记 9%', 'business line unaffected by operator priorities')

  // ---- 5. rate_mode 默认 fixed，非法值拒绝 --------------------------------
  const shopCol = await db.query(
    `select column_default, is_nullable from information_schema.columns
     where table_schema = 'public' and table_name = 'finance_shop_operator_rules'
       and column_name = 'rate_mode'`,
  )
  assert.equal(shopCol.rows[0].is_nullable, 'NO')
  assert.match(String(shopCol.rows[0].column_default), /'fixed'/)
  const assignmentCol = await db.query(
    `select column_default from information_schema.columns
     where table_schema = 'public' and table_name = 'finance_business_order_operator_assignments'
       and column_name = 'rate_mode'`,
  )
  assert.match(String(assignmentCol.rows[0].column_default), /'fixed'/)

  await db.exec(`
    insert into public.profiles (id, role) values
      ('10000000-0000-4000-8000-000000000001', 'operations'),
      ('10000000-0000-4000-8000-000000000003', 'sales');
    insert into public.finance_daily_order_shops (name) values ('店铺一');
  `)
  const shopId = (await db.query(`select id from public.finance_daily_order_shops limit 1`)).rows[0].id
  await db.exec(`
    insert into public.finance_shop_operator_rules (shop_id, operator_id, product_commission_rate)
    values ('${shopId}', '10000000-0000-4000-8000-000000000001', 2);
  `)
  const defaultMode = await db.query(`select rate_mode from public.finance_shop_operator_rules`)
  assert.equal(defaultMode.rows[0].rate_mode, 'fixed', 'existing operator rules default to fixed rate')
  await db.exec(`
    update public.finance_shop_operator_rules set rate_mode = 'rules';
  `)
  await expectError(
    () => db.exec(`update public.finance_shop_operator_rules set rate_mode = 'whatever';`),
    /rate_mode_valid/,
  )

  // ---- 6. 订单时点上下文 RPC ---------------------------------------------
  await db.exec(`
    insert into public.customers (id) values ('${C1}'), ('${C2}');
    insert into public.business_orders (id, customer_id, order_date, status, created_at) values
      ('${O_DEAL_1}',  '${C1}', '2025-01-10', 'approved',  '2025-01-10 09:00+08'),
      ('${O_SAMPLE}',  '${C1}', '2025-02-15', 'approved',  '2025-02-15 09:00+08'),
      ('${O_DEAL_2}',  '${C1}', '2025-04-01', 'completed', '2025-04-01 09:00+08'),
      ('${O_DEAL_3}',  '${C1}', '2026-03-20', 'approved',  '2026-03-20 09:00+08'),
      ('${O_VOIDED}',  '${C1}', '2025-03-01', 'approved',  '2025-03-01 09:00+08'),
      ('${O_PENDING}', '${C1}', '2025-05-01', 'submitted', '2025-05-01 09:00+08'),
      ('${O_NO_CUSTOMER}', null, '2025-06-01', 'approved', '2025-06-01 09:00+08');
    update public.business_orders set voided_at = now() where id = '${O_VOIDED}';
    insert into public.business_order_items (order_id, daily_shipping_category) values
      ('${O_DEAL_1}',  'stock'),
      ('${O_SAMPLE}',  'sample'),
      ('${O_DEAL_2}',  'custom'),
      ('${O_DEAL_3}',  'purchase'),
      ('${O_VOIDED}',  'stock'),
      ('${O_PENDING}', 'stock'),
      ('${O_NO_CUSTOMER}', 'stock');
  `)
  const ctx = await db.query(
    `select order_id::text, customer_order_index, tenure_months
     from public.get_business_order_commission_context(array[
       '${O_DEAL_1}', '${O_SAMPLE}', '${O_DEAL_2}', '${O_DEAL_3}',
       '${O_VOIDED}', '${O_PENDING}', '${O_NO_CUSTOMER}'
     ]::uuid[])`,
  )
  const byOrder = new Map(ctx.rows.map((row) => [row.order_id, row]))
  assert.equal(byOrder.get(O_DEAL_1).customer_order_index, 1)
  assert.equal(byOrder.get(O_DEAL_1).tenure_months, 0, 'first order tenure = 0 months')
  assert.equal(byOrder.get(O_DEAL_2).customer_order_index, 2, 'sample-only order does not consume an index')
  assert.equal(byOrder.get(O_DEAL_2).tenure_months, 2, '2025-01-10 → 2025-04-01 = 2 months')
  assert.equal(byOrder.get(O_DEAL_3).customer_order_index, 3)
  assert.equal(byOrder.get(O_DEAL_3).tenure_months, 14, '2025-01-10 → 2026-03-20 = 14 months')
  assert.equal(byOrder.get(O_SAMPLE).customer_order_index, null, 'sample-only order has no deal index')
  assert.equal(byOrder.get(O_SAMPLE).tenure_months, 1, 'tenure still counts from first deal order')
  assert.equal(byOrder.get(O_VOIDED).customer_order_index, null, 'voided order excluded')
  assert.equal(byOrder.get(O_PENDING).customer_order_index, null, 'unapproved order excluded')
  assert.equal(byOrder.get(O_NO_CUSTOMER).customer_order_index, null, 'order without customer has no index')
  assert.equal(byOrder.get(O_NO_CUSTOMER).tenure_months, null)

  const perms = await db.query(
    `select grantee, privilege_type from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'finance_commission_rules'`,
  )
  const granted = perms.rows.filter((row) => row.grantee === 'authenticated')
  assert.ok(granted.length >= 3, 'authenticated can read/write the rule table')
  assert.ok(!perms.rows.some((row) => row.grantee === 'anon'), 'anon has no grants')

  const policies = await db.query(
    `select policyname from pg_policies
     where schemaname = 'public' and tablename = 'finance_commission_rules'`,
  )
  assert.equal(policies.rows.length, 2, 'select + write policies present')

  console.log('✓ 0154 提成规则迁移演练通过')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
