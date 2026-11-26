const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

async function main() {
  const db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    grant usage on schema public to authenticated, anon;

    create table public.business_orders (
      id uuid primary key,
      customer_id uuid,
      order_date date not null,
      created_at timestamptz not null default now(),
      currency text not null default 'CNY',
      total_amount numeric not null default 0,
      total_cny numeric,
      total_sales_amount numeric,
      salesperson_id uuid,
      shop_id uuid,
      voided_at timestamptz
    );

    create table public.business_order_items (
      id uuid primary key default gen_random_uuid(),
      order_id uuid not null,
      product_id uuid,
      custom_product_id uuid,
      custom_product_version_id uuid,
      daily_shipping_category text,
      origin text default 'original',
      sales_total_amount numeric,
      created_at timestamptz not null default now()
    );

    create table public.products (
      id uuid primary key default gen_random_uuid(),
      group_id uuid
    );

    create table public.business_custom_product_versions (
      id uuid primary key default gen_random_uuid(),
      custom_product_id uuid not null,
      product_group_id uuid,
      version_no int not null
    );

    create table public.business_order_payment_allocations (
      id uuid primary key default gen_random_uuid(),
      order_id uuid not null,
      transfer_id uuid,
      amount numeric not null default 0,
      voided_at timestamptz
    );

    create table public.business_customer_transfers (
      id uuid primary key default gen_random_uuid(),
      currency text not null default 'CNY',
      exchange_rate_to_cny numeric,
      received_at timestamptz not null default now(),
      voided_at timestamptz
    );

    create or replace function public.can_view_business_order(p_order_id uuid)
    returns boolean language sql stable as $$ select true $$;
  `)

  const migration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0165_customer_cohort_performance.sql'),
    'utf8',
  )
  await db.exec(migration)
  // 可重复执行
  await db.exec(migration)

  const a = '10000000-0000-4000-8000-000000000001' // 2024 首单，老客
  const b = '10000000-0000-4000-8000-000000000002' // 2026-03 首单，2026 新客
  const c = '10000000-0000-4000-8000-000000000003' // 2025-11 首单

  await db.exec(`
    insert into public.business_orders
      (id, customer_id, order_date, currency, total_amount, total_cny, total_sales_amount) values
      ('20000000-0000-4000-8000-000000000001', '${a}', '2024-05-10', 'CNY', 1000, 1000, 0),
      ('20000000-0000-4000-8000-000000000002', '${a}', '2025-06-01', 'USD', 200, 1400, 0),
      ('20000000-0000-4000-8000-000000000003', '${a}', '2026-01-10', 'CNY', 3000, 3000, 0),
      ('20000000-0000-4000-8000-000000000004', '${c}', '2025-11-05', 'CNY', 500, 500, 0),
      ('20000000-0000-4000-8000-000000000005', '${c}', '2026-02-20', 'USD', 50, 350, 0),
      ('20000000-0000-4000-8000-000000000006', '${b}', '2026-03-10', 'CNY', 800, 800, 0),
      ('20000000-0000-4000-8000-000000000007', null, '2026-01-20', 'CNY', 70, 70, 0);
    insert into public.business_orders
      (id, customer_id, order_date, currency, total_amount, total_cny, voided_at) values
      ('20000000-0000-4000-8000-000000000008', '${b}', '2026-03-15', 'CNY', 999, 999, '2026-03-16T00:00:00Z');

    insert into public.business_order_items (order_id, daily_shipping_category) values
      ('20000000-0000-4000-8000-000000000001', 'custom'),
      ('20000000-0000-4000-8000-000000000002', 'stock'),
      ('20000000-0000-4000-8000-000000000003', 'custom'),
      ('20000000-0000-4000-8000-000000000004', 'custom'),
      ('20000000-0000-4000-8000-000000000005', 'custom'),
      ('20000000-0000-4000-8000-000000000006', 'custom'),
      ('20000000-0000-4000-8000-000000000007', 'custom');
  `)

  const { rows } = await db.query(
    `select * from public.get_business_performance_customer_cohorts()`,
  )
  const pick = (section, key) => {
    const row = rows.find((r) => r.section === section && r.period_key === key)
    assert.ok(row, `missing row ${section}/${key}`)
    return row
  }

  const y2026 = pick('period_calendar', '2026')
  assert.equal(Number(y2026.new_customer_count), 1, '2026 新客数')
  assert.equal(Number(y2026.new_order_count), 1, '2026 新客单数')
  assert.equal(Number(y2026.new_amount_cny), 800)
  assert.equal(Number(y2026.new_amount_usd), 0)
  assert.equal(Number(y2026.old_customer_count), 2, '2026 在买老客数 A/C')
  assert.equal(Number(y2026.old_amount_cny), 3000)
  assert.equal(Number(y2026.old_amount_usd), 50)
  assert.equal(Number(y2026.unbound_order_count), 1)
  assert.equal(Number(y2026.unbound_amount_cny), 70)
  assert.equal(Number(y2026.active_customer_count), 3)
  assert.equal(Number(y2026.prior_active_customer_count), 2, '2025 在买 A/C')
  assert.equal(Number(y2026.retained_customer_count), 2, 'A/C 自 2025 留存')

  // 年限结构：2026 年 A 首单 2024-05 → 2 年以上；B 新客与 C（2025-11 首单）都在首年内
  assert.equal(Number(y2026.first_year_amount_cny), 800)
  assert.equal(Number(y2026.first_year_amount_usd), 50)
  assert.equal(Number(y2026.one_two_year_amount_cny), 3000)
  assert.equal(Number(y2026.two_plus_year_amount_cny), 0)

  const y2025 = pick('period_calendar', '2025')
  assert.equal(Number(y2025.new_customer_count), 1, '2025 新客 C')
  assert.equal(Number(y2025.new_amount_cny), 500)
  assert.equal(Number(y2025.old_amount_cny), 0)
  assert.equal(Number(y2025.old_amount_usd), 200)

  const jan = pick('month', '2026-01')
  assert.equal(Number(jan.new_customer_count), 0)
  assert.equal(Number(jan.old_customer_count), 1)
  assert.equal(Number(jan.old_amount_cny), 3000)
  assert.equal(Number(jan.unbound_amount_cny), 70)

  const mar = pick('month', '2026-03')
  assert.equal(Number(mar.new_customer_count), 1)
  assert.equal(Number(mar.new_amount_cny), 800, '作废订单不计')
  assert.equal(Number(mar.old_amount_cny), 0)

  const rolling = rows.filter((r) => r.section === 'period_rolling')
  assert.ok(rolling.length >= 2, '滚动窗口至少两期')
  assert.equal(rolling[rolling.length - 1].period_key, '2025-12~2026-11')
  assert.equal(Number(rolling[rolling.length - 1].new_customer_count), 1)
  assert.equal(Number(rolling[rolling.length - 1].old_customer_count), 2)
  assert.equal(Number(rolling[rolling.length - 1].old_amount_usd), 50)

  // 发货分类筛选：只剩 stock 一单（A 2025-06），月/年金额随之收敛
  const { rows: stockRows } = await db.query(
    `select * from public.get_business_performance_customer_cohorts(p_shipping_categories => array['stock'])`,
  )
  const stockYear = stockRows.find((r) => r.section === 'period_calendar' && r.period_key === '2025')
  assert.equal(Number(stockYear.old_amount_usd), 200)
  assert.equal(Number(stockYear.old_amount_cny), 0)
  assert.equal(Number(stockYear.new_customer_count), 0)

  // 下单日期筛选：只保留 2026，2026 仍判 C 为老客（首单在 2025，不受筛选影响）
  const { rows: y2026Rows } = await db.query(
    `select * from public.get_business_performance_customer_cohorts(
       p_date_from => '2026-01-01', p_date_to => '2026-12-31')`,
  )
  const filtered2026 = y2026Rows.find(
    (r) => r.section === 'period_calendar' && r.period_key === '2026',
  )
  assert.equal(Number(filtered2026.old_customer_count), 2)
  assert.equal(Number(filtered2026.new_customer_count), 1)
  const months = y2026Rows.filter((r) => r.section === 'month')
  assert.equal(months.length, 12, '显式区间按区间生成月度序列')
  assert.equal(months[0].period_key, '2026-01')

  // 选定区间新客户首年成交：新增客户 D（2026-05 首单，2027-06 单在首年窗口外）
  // 以及 B 的一年内追加单、一年外超窗单；此前断言已执行完，不受影响。
  const d = '10000000-0000-4000-8000-000000000004'
  await db.exec(`
    insert into public.business_orders
      (id, customer_id, order_date, currency, total_amount, total_cny) values
      ('20000000-0000-4000-8000-000000000009', '${b}', '2026-06-01', 'CNY', 400, 400),
      ('20000000-0000-4000-8000-000000000010', '${b}', '2027-04-01', 'CNY', 1000, 1000),
      ('20000000-0000-4000-8000-000000000011', '${d}', '2026-05-10', 'CNY', 500, 500),
      ('20000000-0000-4000-8000-000000000012', '${d}', '2026-09-01', 'USD', 100, 700),
      ('20000000-0000-4000-8000-000000000013', '${d}', '2027-06-01', 'CNY', 900, 900);
  `)
  const { rows: firstYearRows } = await db.query(
    `select * from public.get_business_performance_new_customer_first_year(
       p_window_from => '2026-01-01', p_window_to => '2026-12-31')`,
  )
  const firstYearPick = (key) => {
    const row = firstYearRows.find((r) => r.period_key === key)
    assert.ok(row, `missing first-year row ${key}`)
    return row
  }
  assert.equal(firstYearRows.length, 2, '首单在 2026 的客户只有 B/D')
  const fyMar = firstYearPick('2026-03')
  assert.equal(Number(fyMar.customer_count), 1)
  assert.equal(Number(fyMar.first_order_count), 1)
  assert.equal(Number(fyMar.first_order_amount_cny), 800)
  assert.equal(Number(fyMar.follow_up_order_count), 1, 'B 2026-06 追加 1 单')
  assert.equal(Number(fyMar.follow_up_amount_cny), 400)
  assert.equal(Number(fyMar.first_year_order_count), 2, 'B 2027-04 超出首年窗口不计')
  assert.equal(Number(fyMar.first_year_amount_cny), 1200)
  const fyMay = firstYearPick('2026-05')
  assert.equal(Number(fyMay.customer_count), 1)
  assert.equal(Number(fyMay.first_order_amount_cny), 500)
  assert.equal(Number(fyMay.follow_up_order_count), 1)
  assert.equal(Number(fyMay.follow_up_amount_usd), 100)
  assert.equal(Number(fyMay.first_year_order_count), 2, 'D 2027-06 超出首年窗口不计')
  assert.equal(Number(fyMay.first_year_amount_cny), 500)
  assert.equal(Number(fyMay.first_year_amount_usd), 100)

  // 区间只决定新客身份：只选 2026-04 之后，B（首单 2026-03）不算新客
  const { rows: lateRows } = await db.query(
    `select * from public.get_business_performance_new_customer_first_year(
       p_window_from => '2026-04-01', p_window_to => '2026-12-31')`,
  )
  assert.equal(lateRows.length, 1)
  assert.equal(lateRows[0].period_key, '2026-05')
  assert.equal(Number(lateRows[0].customer_count), 1)

  console.log('0165 customer cohort verification passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
