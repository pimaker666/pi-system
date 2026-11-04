const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

const FINANCE = '10000000-0000-4000-8000-000000000001'
const SALES = '10000000-0000-4000-8000-000000000002'
const ITEM = '20000000-0000-4000-8000-000000000001'
const ORDER = '30000000-0000-4000-8000-000000000001'

async function main() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;

    create table public.profiles (id uuid primary key, role text not null, status text not null);
    insert into profiles values
      ('${FINANCE}', 'finance', 'approved'),
      ('${SALES}', 'sales', 'approved');
    create function public.is_finance_or_admin() returns boolean language sql security definer as $$
      select exists(select 1 from profiles where id = auth.uid() and role in ('admin', 'finance') and status = 'approved') $$;
    grant usage on schema public to authenticated, anon;
    grant execute on function public.is_finance_or_admin() to authenticated, anon;

    create table public.business_orders (id uuid primary key);
    create table public.business_order_items (
      id uuid primary key,
      order_id uuid not null references public.business_orders(id)
    );
    insert into business_orders values ('${ORDER}');
    insert into business_order_items values ('${ITEM}', '${ORDER}');

    -- 与 0065/0074 同名同列的最小表，供 0135 的约束加固直接作用
    create table public.finance_business_order_item_commissions (
      business_order_item_id uuid primary key,
      commission_rate numeric(7,4) not null,
      updated_by uuid,
      constraint finance_business_order_item_commission_valid check (commission_rate >= 0)
    );
    create table public.finance_business_order_commissions (
      business_order_id uuid primary key,
      freight_cost numeric(18,4) not null default 0,
      freight_commission_rate numeric(7,4) not null default 0,
      updated_by uuid,
      constraint finance_business_order_commission_valid
        check (freight_cost >= 0 and freight_commission_rate >= 0)
    );
    create table public.finance_commission_category_rates (
      category text primary key,
      product_commission_rate numeric(7,4) not null default 0,
      constraint finance_commission_category_rate_valid check (product_commission_rate >= 0)
    );
    create table public.payroll_items (
      id uuid primary key default gen_random_uuid(),
      base_salary numeric(18,2) not null default 0,
      commission numeric(18,2) not null default 0,
      bonus numeric(18,2) not null default 0,
      attendance_deduction numeric(18,2) not null default 0,
      other_deduction numeric(18,2) not null default 0,
      social_insurance numeric(18,2) not null default 0,
      housing_fund numeric(18,2) not null default 0,
      tax numeric(18,2) not null default 0
    );
    create table public.finance_business_order_item_commission_clearances (
      business_order_item_id uuid primary key,
      period date not null,
      status text not null default 'pending',
      submitted_by uuid,
      submitted_at timestamptz not null default now(),
      confirmed_by uuid,
      confirmed_at timestamptz,
      rejected_reason text,
      rejected_read_at timestamptz
    );
    grant all on all tables in schema public to authenticated;
  `)

  const migration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0135_numeric_and_clearance_hardening.sql'),
    'utf8',
  )
  await db.exec(migration)
  // 幂等：再跑一遍不报错
  await db.exec(migration)

  const as = async (uid, fn) => {
    if (uid) {
      await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`)
    } else {
      await db.exec(`reset role; reset request.jwt.claim.sub;`)
    }
    try {
      return await fn()
    } finally {
      await db.exec('reset role; reset request.jwt.claim.sub;')
    }
  }

  // ---------- 1. 提点与工资金额上限 ----------
  await as(FINANCE, async () => {
    await db.query(`insert into public.finance_business_order_item_commissions(business_order_item_id, commission_rate)
      values ('${ITEM}', 100)`)
    await assert.rejects(
      () => db.query(`update public.finance_business_order_item_commissions set commission_rate = 100.0001 where business_order_item_id = '${ITEM}'`),
      /check/i,
      '产品提点不得超过 100',
    )
    await db.query(`insert into public.finance_business_order_commissions(business_order_id, freight_cost, freight_commission_rate)
      values ('${ORDER}', 100, 100)`)
    await assert.rejects(
      () => db.query(`update public.finance_business_order_commissions set freight_commission_rate = 101 where business_order_id = '${ORDER}'`),
      /check/i,
      '运费提点不得超过 100',
    )
    await db.query(`insert into public.finance_commission_category_rates(category, product_commission_rate) values ('stock', 100)`)
    await assert.rejects(
      () => db.query(`update public.finance_commission_category_rates set product_commission_rate = 101 where category = 'stock'`),
      /check/i,
      '分类默认提点不得超过 100',
    )
    await assert.rejects(
      () => db.query(`insert into public.payroll_items(base_salary) values (-1)`),
      /check/i,
      '工资金额不得为负',
    )
    await db.query(`insert into public.payroll_items(base_salary, commission, tax) values (0, 0, 0)`)
  })

  // ---------- 2. 业务员只能确认/驳回，不能篡改月份与审计字段 ----------
  await db.query(`insert into public.finance_business_order_item_commission_clearances
    (business_order_item_id, period, status, submitted_by) values ('${ITEM}', '2026-11-01', 'pending', '${FINANCE}')`)

  await as(SALES, async () => {
    await assert.rejects(
      () => db.query(`update public.finance_business_order_item_commission_clearances
        set status = 'confirmed', confirmed_by = '${SALES}', confirmed_at = now(), period = '2026-10-01'
        where business_order_item_id = '${ITEM}'`),
      /period or submitter/i,
      '业务员不能改结清月份',
    )
    await assert.rejects(
      () => db.query(`update public.finance_business_order_item_commission_clearances
        set status = 'confirmed', confirmed_by = '${FINANCE}', confirmed_at = now()
        where business_order_item_id = '${ITEM}'`),
      /acting salesperson/i,
      '确认人只能是本人',
    )
    await assert.rejects(
      () => db.query(`update public.finance_business_order_item_commission_clearances
        set rejected_read_at = now()
        where business_order_item_id = '${ITEM}'`),
      /only confirm or reject pending/i,
      '业务员不能改 pending 的其他字段',
    )
    await db.query(`update public.finance_business_order_item_commission_clearances
      set status = 'confirmed', confirmed_by = '${SALES}', confirmed_at = now()
      where business_order_item_id = '${ITEM}'`)
    assert.equal(
      (await db.query(`select status from public.finance_business_order_item_commission_clearances where business_order_item_id = '${ITEM}'`)).rows[0].status,
      'confirmed',
      '业务员可确认本人待结清记录',
    )
    await assert.rejects(
      () => db.query(`update public.finance_business_order_item_commission_clearances
        set status = 'rejected', confirmed_by = null
        where business_order_item_id = '${ITEM}'`),
      /only confirm or reject pending/i,
      '已确认记录不能再改',
    )
  })

  // ---------- 3. 财务可调整月份 / 无登录身份（service_role）不被触发器限制 ----------
  await as(FINANCE, async () => {
    await db.query(`update public.finance_business_order_item_commission_clearances
      set status = 'pending', period = '2026-10-01', confirmed_by = null, confirmed_at = null
      where business_order_item_id = '${ITEM}'`)
    assert.equal(
      (await db.query(`select period::text p from public.finance_business_order_item_commission_clearances where business_order_item_id = '${ITEM}'`)).rows[0].p,
      '2026-10-01',
      '财务可调整结清月份',
    )
  })
  await as(null, async () => {
    await db.query(`update public.finance_business_order_item_commission_clearances
      set status = 'confirmed', confirmed_by = '${FINANCE}', confirmed_at = now()
      where business_order_item_id = '${ITEM}'`)
  })

  console.log('✓ 0135 数值上限与结清审计字段演练通过')
}

main().catch((error) => {
  console.error('✗ 0135 演练失败：', error.message)
  process.exit(1)
})
