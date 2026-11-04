const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

const FINANCE = '10000000-0000-4000-8000-000000000001'
const SALES = '10000000-0000-4000-8000-000000000002'

const migration = (name) =>
  fs.readFileSync(path.join(__dirname, '../supabase/migrations', name), 'utf8')

async function main() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;

    create table public.profiles (
      id uuid primary key,
      role text not null,
      status text not null,
      full_name text,
      chinese_name text,
      email text,
      created_at timestamptz not null default now()
    );
    insert into profiles values
      ('${FINANCE}', 'finance', 'approved', '周乐晶', null, 'fin@test.com', '2026-01-01'),
      ('${SALES}', 'sales', 'approved', '朱可欣', '可欣', 'sales@test.com', '2026-02-01');
    create function public.is_finance_or_admin() returns boolean language sql security definer as $$
      select exists(select 1 from profiles where id = auth.uid() and role in ('admin', 'finance') and status = 'approved') $$;
    create function public.touch_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at = now(); return new; end $$;
    grant usage on schema public to authenticated, anon;
    grant select, delete on public.profiles to authenticated;

    create table public.business_orders (id uuid primary key);
    create table public.business_order_items (
      id uuid primary key,
      order_id uuid not null references public.business_orders(id) on delete cascade
    );
    create table public.finance_business_order_item_commissions (
      business_order_item_id uuid primary key
        references public.business_order_items(id) on delete cascade,
      commission_rate numeric(7,4) not null default 0,
      updated_by uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table public.finance_business_order_commissions (
      business_order_id uuid primary key references public.business_orders(id) on delete cascade,
      freight_cost numeric(18,4) not null default 0,
      freight_commission_rate numeric(7,4) not null default 0,
      settlement_exchange_rate_to_cny numeric(18,6),
      updated_by uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table public.finance_business_order_item_commission_clearances (
      business_order_item_id uuid primary key
        references public.business_order_items(id) on delete cascade,
      period date not null default '2099-01-01',
      status text not null default 'pending'
        check (status in ('pending', 'confirmed', 'rejected')),
      submitted_by uuid,
      confirmed_by uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    grant all on public.business_orders, public.business_order_items,
      public.finance_business_order_item_commissions,
      public.finance_business_order_commissions,
      public.finance_business_order_item_commission_clearances
      to authenticated, service_role;
  `)

  await db.exec(migration('0122_payroll_attendance.sql'))
  await db.exec(migration('0129_payroll_autofill.sql'))
  await db.exec(migration('0133_payroll_publish_lock.sql'))
  await db.exec(migration('0134_commission_clearance_lock.sql'))
  // 幂等：再跑一遍不报错
  await db.exec(migration('0134_commission_clearance_lock.sql'))

  const as = async (uid, fn) => {
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`)
    try {
      return await fn()
    } finally {
      await db.exec('reset role; reset request.jwt.claim.sub;')
    }
  }

  await db.exec(`
    insert into business_orders values
      ('20000000-0000-4000-8000-000000000001'),
      ('20000000-0000-4000-8000-000000000002'),
      ('20000000-0000-4000-8000-000000000003');
    insert into business_order_items values
      ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001'),
      ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001'),
      ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002'),
      ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000003');
    insert into finance_business_order_item_commissions(business_order_item_id, commission_rate) values
      ('30000000-0000-4000-8000-000000000001', 5),
      ('30000000-0000-4000-8000-000000000003', 4);
    insert into finance_business_order_commissions(business_order_id, freight_cost, freight_commission_rate, settlement_exchange_rate_to_cny) values
      ('20000000-0000-4000-8000-000000000001', 100, 3, 7.1),
      ('20000000-0000-4000-8000-000000000002', 50, 3, 7.2);
  `)

  // ---------- 待确认结清：提点/运费/汇率全部锁定 ----------
  await db.exec(`
    insert into finance_business_order_item_commission_clearances(business_order_item_id, submitted_by)
    values ('30000000-0000-4000-8000-000000000001', '${FINANCE}')
  `)
  await as(SALES, async () => {
    await assert.rejects(
      () => db.query(`update finance_business_order_item_commissions set commission_rate = 9
        where business_order_item_id = '30000000-0000-4000-8000-000000000001'`),
      /locked by an active clearance/,
    )
    await assert.rejects(
      () => db.query(`delete from finance_business_order_item_commissions
        where business_order_item_id = '30000000-0000-4000-8000-000000000001'`),
      /locked by an active clearance/,
    )
    await assert.rejects(
      () => db.query(`update finance_business_order_commissions set freight_cost = 999
        where business_order_id = '20000000-0000-4000-8000-000000000001'`),
      /locked by an active clearance/,
    )
    await assert.rejects(
      () => db.query(`update finance_business_order_commissions set settlement_exchange_rate_to_cny = 8
        where business_order_id = '20000000-0000-4000-8000-000000000001'`),
      /locked by an active clearance/,
    )
    // 未结清的产品行/订单不受影响
    await db.query(`update finance_business_order_item_commissions set commission_rate = 6
      where business_order_item_id = '30000000-0000-4000-8000-000000000003'`)
    await db.query(`update finance_business_order_commissions set freight_cost = 60
      where business_order_id = '20000000-0000-4000-8000-000000000002'`)
  })

  // 锁定产品行补插提点覆盖也要拦截
  await db.exec(`
    insert into finance_business_order_item_commission_clearances(business_order_item_id, submitted_by)
    values ('30000000-0000-4000-8000-000000000004', '${FINANCE}')
  `)
  await as(SALES, async () => {
    await assert.rejects(
      () => db.query(`insert into finance_business_order_item_commissions(business_order_item_id, commission_rate)
        values ('30000000-0000-4000-8000-000000000004', 2)`),
      /locked by an active clearance/,
    )
    await assert.rejects(
      () => db.query(`insert into finance_business_order_commissions(business_order_id, freight_cost)
        values ('20000000-0000-4000-8000-000000000003', 10)`),
      /locked by an active clearance/,
    )
  })

  // 驳回后解锁；已确认结清继续保持锁定
  await db.exec(`update finance_business_order_item_commission_clearances set status = 'rejected'
    where business_order_item_id = '30000000-0000-4000-8000-000000000001'`)
  await db.query(`update finance_business_order_item_commissions set commission_rate = 7
    where business_order_item_id = '30000000-0000-4000-8000-000000000001'`)
  await db.query(`update finance_business_order_commissions set freight_cost = 120
    where business_order_id = '20000000-0000-4000-8000-000000000001'`)

  await db.exec(`update finance_business_order_item_commission_clearances set status = 'confirmed'
    where business_order_item_id = '30000000-0000-4000-8000-000000000001'`)
  await assert.rejects(
    () => db.query(`update finance_business_order_item_commissions set commission_rate = 8
      where business_order_item_id = '30000000-0000-4000-8000-000000000001'`),
    /locked by an active clearance/,
  )
  // 撤销结清（删除记录）后解锁
  await db.query(`delete from finance_business_order_item_commission_clearances
    where business_order_item_id = '30000000-0000-4000-8000-000000000001'`)
  await db.query(`update finance_business_order_item_commissions set commission_rate = 8
    where business_order_item_id = '30000000-0000-4000-8000-000000000001'`)

  // 级联删除不受影响
  await db.query(`delete from business_orders where id = '20000000-0000-4000-8000-000000000003'`)

  // 已锁定产品行所在订单被删除时，提点覆盖与其订单运费仍可级联清理
  await db.exec(`
    insert into finance_business_order_item_commission_clearances(business_order_item_id, status)
    values ('30000000-0000-4000-8000-000000000003', 'confirmed')
  `)
  await db.query(`delete from business_orders where id = '20000000-0000-4000-8000-000000000002'`)
  const cascaded = (await db.query(`
    select
      (select count(*) from finance_business_order_item_commissions
        where business_order_item_id = '30000000-0000-4000-8000-000000000003')::int as item_rows,
      (select count(*) from finance_business_order_commissions
        where business_order_id = '20000000-0000-4000-8000-000000000002')::int as order_rows
  `)).rows[0]
  assert.equal(cascaded.item_rows, 0, '删除订单级联清理提点覆盖')
  assert.equal(cascaded.order_rows, 0, '删除订单级联清理运费提成')

  // ---------- 已发布工资表：发放月份/满勤天数只读 ----------
  let sheetId
  await as(FINANCE, async () => {
    const sheet = await db.query(`insert into public.payroll_sheets(period_month, full_attendance_days, created_by)
      values ('2099-05-01', 22, auth.uid()) returning id`)
    sheetId = sheet.rows[0].id
    await db.query(`insert into public.payroll_items(sheet_id, profile_id, base_salary)
      values ('${sheetId}', '${SALES}', 8000)`)
    await db.query(`update public.payroll_sheets set status = 'published' where id = '${sheetId}'`)
    await assert.rejects(
      () => db.query(`update public.payroll_sheets set payout_month = '2099-06-01' where id = '${sheetId}'`),
      /Published payroll sheet is locked/,
    )
    await assert.rejects(
      () => db.query(`update public.payroll_sheets set full_attendance_days = 20 where id = '${sheetId}'`),
      /Published payroll sheet is locked/,
    )
    // 直接改状态绕过撤回 RPC 会被拒绝
    await assert.rejects(
      () => db.query(`update public.payroll_sheets set status = 'draft' where id = '${sheetId}'`),
      /Use unpublish_payroll_sheet/,
    )
    await db.query(`select public.unpublish_payroll_sheet('${sheetId}')`)
    const afterUnpublish = (await db.query(`select status, published_by from public.payroll_sheets where id = '${sheetId}'`)).rows[0]
    assert.equal(afterUnpublish.status, 'draft', '撤回后状态回草稿')
    assert.equal(afterUnpublish.published_by, null, '撤回后清空发布人')
    await db.query(`update public.payroll_sheets set payout_month = '2099-06-01' where id = '${sheetId}'`)
  })

  console.log('✓ 0134 提成结清锁 + 工资表元数据锁演练通过')
}

main().catch((error) => {
  console.error('✗ 0134 演练失败：', error.message)
  process.exit(1)
})
