const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PGlite } = require('@electric-sql/pglite')

async function main() {
  const db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    grant usage on schema public to authenticated, anon;

    create type public.business_order_status as enum (
      'draft', 'submitted', 'rejected', 'approved', 'completed'
    );
    create type public.currency_code as enum ('USD', 'CNY');

    create table public.finance_orders (
      id uuid primary key default gen_random_uuid(),
      order_date date not null,
      amount_cny numeric not null,
      status text not null
    );
    create table public.business_orders (
      id uuid primary key default gen_random_uuid(),
      order_date date not null,
      status public.business_order_status not null,
      fulfillment_status text not null,
      voided_at timestamptz,
      total_amount numeric not null,
      total_sales_amount numeric,
      total_cny numeric,
      currency public.currency_code not null
    );
    create table public.finance_transactions (
      id uuid primary key default gen_random_uuid(),
      transaction_type text not null,
      transaction_date date not null,
      amount_cny numeric not null,
      status text not null
    );
    create table public.business_customer_transfers (
      id uuid primary key default gen_random_uuid(),
      received_at timestamptz not null,
      exchange_rate_to_cny numeric,
      voided_at timestamptz
    );
    create table public.business_order_payment_allocations (
      id uuid primary key default gen_random_uuid(),
      order_id uuid not null,
      transfer_id uuid not null,
      amount numeric not null,
      voided_at timestamptz
    );
    create table public.finance_order_costs (
      id uuid primary key default gen_random_uuid(),
      finance_order_id uuid,
      business_order_id uuid,
      amount_cny numeric not null
    );
    create table public.business_order_finance_details (
      order_id uuid primary key,
      wage_amount_cny numeric not null
    );
  `)

  const migration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0145_finance_overview_completion_scope.sql'),
    'utf8',
  )
  await db.exec(migration)

  const ids = {
    legacyIn: '10000000-0000-4000-8000-000000000001',
    legacyVoid: '10000000-0000-4000-8000-000000000002',
    legacyOut: '10000000-0000-4000-8000-000000000003',
    manual: '20000000-0000-4000-8000-000000000001',
    shippedPaid: '20000000-0000-4000-8000-000000000002',
    shippedPartial: '20000000-0000-4000-8000-000000000003',
    paidBySalesAmount: '20000000-0000-4000-8000-000000000004',
    unshippedPaid: '20000000-0000-4000-8000-000000000005',
    draftShippedPaid: '20000000-0000-4000-8000-000000000006',
    voidedCompleted: '20000000-0000-4000-8000-000000000007',
    unpriced: '20000000-0000-4000-8000-000000000008',
    outOfRange: '20000000-0000-4000-8000-000000000009',
    voidedTransfer: '30000000-0000-4000-8000-000000000003',
    transferA: '30000000-0000-4000-8000-000000000001',
    transferB: '30000000-0000-4000-8000-000000000002',
  }

  await db.exec(`
    insert into public.finance_orders (id, order_date, amount_cny, status) values
      ('${ids.legacyIn}', '2026-03-05', 1000, 'active'),
      ('${ids.legacyVoid}', '2026-03-06', 5000, 'void'),
      ('${ids.legacyOut}', '2026-01-05', 2000, 'active');

    insert into public.business_orders
      (id, order_date, status, fulfillment_status, voided_at,
       total_amount, total_sales_amount, total_cny, currency) values
      ('${ids.manual}', '2026-03-02', 'completed', 'unshipped', null, 100, null, 700, 'USD'),
      ('${ids.shippedPaid}', '2026-03-03', 'approved', 'fully_shipped', null, 200, 0, 1400, 'USD'),
      ('${ids.shippedPartial}', '2026-03-04', 'approved', 'fully_shipped', null, 150, 0, 1050, 'USD'),
      ('${ids.paidBySalesAmount}', '2026-03-05', 'approved', 'fully_shipped', null, 80, 80, 80, 'CNY'),
      ('${ids.unshippedPaid}', '2026-03-06', 'approved', 'partial_shipped', null, 60, 60, 60, 'CNY'),
      ('${ids.draftShippedPaid}', '2026-03-07', 'draft', 'fully_shipped', null, 30, 30, 30, 'USD'),
      ('${ids.voidedCompleted}', '2026-03-08', 'completed', 'fully_shipped', '2026-03-09T00:00:00Z', 400, 400, 400, 'USD'),
      ('${ids.unpriced}', '2026-03-09', 'completed', 'unshipped', null, 50, null, null, 'USD'),
      ('${ids.outOfRange}', '2026-02-20', 'approved', 'fully_shipped', null, 150, 150, 900, 'USD');

    insert into public.finance_transactions
      (transaction_type, transaction_date, amount_cny, status) values
      ('income', '2026-03-10', 200, 'active'),
      ('expense', '2026-03-11', 80, 'active'),
      ('income', '2026-01-03', 999, 'active'),
      ('income', '2026-03-12', 777, 'void');

    insert into public.business_customer_transfers
      (id, received_at, exchange_rate_to_cny, voided_at) values
      ('${ids.transferA}', '2026-03-15T02:00:00Z', 7, null),
      ('${ids.voidedTransfer}', '2026-03-16T02:00:00Z', 7, '2026-03-17T00:00:00Z');

    insert into public.business_order_payment_allocations
      (order_id, transfer_id, amount, voided_at) values
      ('${ids.shippedPaid}', '${ids.transferA}', 200, null),
      ('${ids.shippedPartial}', '${ids.transferA}', 100, null),
      ('${ids.paidBySalesAmount}', '${ids.transferA}', 10, '2026-03-18T00:00:00Z'),
      ('${ids.manual}', '${ids.voidedTransfer}', 10, null);

    insert into public.finance_order_costs
      (finance_order_id, business_order_id, amount_cny) values
      ('${ids.legacyIn}', null, 150),
      ('${ids.legacyVoid}', null, 500),
      ('${ids.legacyOut}', null, 900),
      (null, '${ids.manual}', 50),
      (null, '${ids.shippedPaid}', 100),
      (null, '${ids.shippedPartial}', 77),
      (null, '${ids.paidBySalesAmount}', 20),
      (null, '${ids.unpriced}', 5),
      (null, '${ids.outOfRange}', 999);

    insert into public.business_order_finance_details (order_id, wage_amount_cny) values
      ('${ids.shippedPaid}', 30),
      ('${ids.shippedPartial}', 40);
  `)

  const ranged = await db.query(
    `select * from public.get_finance_overview('2026-03-01'::date, '2026-03-31'::date)`,
  )
  assert.equal(ranged.rows.length, 1)
  const row = ranged.rows[0]

  assert.equal(
    Number(row.order_revenue),
    3180,
    '业绩 = 旧订单 1000 + 手动完成 700 + 发货收齐 1400 + 销售额抵清 80；草稿/部分收款/作废/区间外不计',
  )
  assert.equal(Number(row.income), 200, '收入只取日记账，客户转账不再计入')
  assert.equal(Number(row.expense), 80)
  assert.equal(Number(row.cash_balance), 120, '现金净额 = 日记账收入 - 日记账支出')
  assert.equal(Number(row.order_costs), 355, '成本 = 旧订单 150 + 已完成订单成本 175 + 工资 30')
  assert.equal(Number(row.gross_profit), 2825)
  assert.equal(Number(row.completed_order_count), 4, '手动完成 + 发货收齐 + 销售额抵清 + 缺汇率')
  assert.equal(Number(row.in_progress_order_count), 2, '部分收款与未发货各算一笔进行中')
  assert.equal(Number(row.unpriced_completed_order_count), 1)
  assert.deepEqual(row.in_progress_totals, { USD: 150, CNY: 60 })

  const all = await db.query(`select * from public.get_finance_overview()`)
  const allRow = all.rows[0]
  assert.equal(Number(allRow.order_revenue), 6080)
  assert.equal(Number(allRow.income), 1199)
  assert.equal(Number(allRow.expense), 80)
  assert.equal(Number(allRow.cash_balance), 1119)
  assert.equal(Number(allRow.order_costs), 2254)
  assert.equal(Number(allRow.gross_profit), 3826)
  assert.equal(Number(allRow.completed_order_count), 5)
  assert.equal(Number(allRow.in_progress_order_count), 2)

  // 现金趋势：只认日记账；客户转账不进趋势。
  const trend = await db.query(`select * from public.get_finance_cash_trend(6)`)
  assert.equal(trend.rows.length, 6)
  const months = trend.rows.map((item) => item.month)
  assert.deepEqual(months, [...months].sort(), '月份按升序返回')
  const currentMonth = (
    await db.query(
      `select to_char((now() at time zone 'Asia/Shanghai')::date, 'YYYY-MM') as month`,
    )
  ).rows[0].month
  assert.equal(months.at(-1), currentMonth)

  await db.exec(`
    insert into public.finance_transactions
      (transaction_type, transaction_date, amount_cny, status) values
      ('income', (now() at time zone 'Asia/Shanghai')::date, 500, 'active'),
      ('expense', (now() at time zone 'Asia/Shanghai')::date, 25, 'active');
    insert into public.business_customer_transfers
      (id, received_at, exchange_rate_to_cny, voided_at) values
      ('30000000-0000-4000-8000-000000000004', now(), 7, null);
    insert into public.business_order_payment_allocations
      (order_id, transfer_id, amount, voided_at) values
      ('${ids.shippedPaid}', '30000000-0000-4000-8000-000000000004', 10, null);
  `)
  const trend2 = await db.query(`select * from public.get_finance_cash_trend(6)`)
  const latest = trend2.rows.at(-1)
  assert.equal(Number(latest.income), 500, '当月新转账 70 不应进入趋势收入')
  assert.equal(Number(latest.expense), 25)

  const oneMonth = await db.query(`select * from public.get_finance_cash_trend(0)`)
  assert.equal(oneMonth.rows.length, 1, 'p_months 下限收敛为 1')
  const capped = await db.query(`select * from public.get_finance_cash_trend(100)`)
  assert.equal(capped.rows.length, 24, 'p_months 上限收敛为 24')

  const grants = await db.query(`
    select
      has_function_privilege('authenticated', 'public.get_finance_overview(date,date)', 'execute') as overview_auth,
      has_function_privilege('anon', 'public.get_finance_overview(date,date)', 'execute') as overview_anon,
      has_function_privilege('authenticated', 'public.get_finance_cash_trend(integer)', 'execute') as trend_auth,
      has_function_privilege('anon', 'public.get_finance_cash_trend(integer)', 'execute') as trend_anon
  `)
  assert.equal(grants.rows[0].overview_auth, true)
  assert.equal(grants.rows[0].overview_anon, false)
  assert.equal(grants.rows[0].trend_auth, true)
  assert.equal(grants.rows[0].trend_anon, false)

  await db.close()
  console.log('verify-0145: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
