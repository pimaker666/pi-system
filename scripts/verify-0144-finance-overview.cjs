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
      voided_at timestamptz,
      total_amount numeric not null,
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
    path.join(__dirname, '../supabase/migrations/0144_finance_overview_range.sql'),
    'utf8',
  )
  await db.exec(migration)

  const ids = {
    legacyIn: '10000000-0000-4000-8000-000000000001',
    legacyVoid: '10000000-0000-4000-8000-000000000002',
    legacyOut: '10000000-0000-4000-8000-000000000003',
    completedUsd: '20000000-0000-4000-8000-000000000001',
    completedUnpriced: '20000000-0000-4000-8000-000000000002',
    completedOut: '20000000-0000-4000-8000-000000000003',
    submittedUsd: '20000000-0000-4000-8000-000000000004',
    approvedCny: '20000000-0000-4000-8000-000000000005',
    draft: '20000000-0000-4000-8000-000000000006',
    voidedCompleted: '20000000-0000-4000-8000-000000000007',
    transfer: '30000000-0000-4000-8000-000000000001',
  }

  await db.exec(`
    insert into public.finance_orders (id, order_date, amount_cny, status) values
      ('${ids.legacyIn}', '2026-03-05', 1000, 'active'),
      ('${ids.legacyVoid}', '2026-03-06', 5000, 'void'),
      ('${ids.legacyOut}', '2026-01-05', 2000, 'active');

    insert into public.business_orders
      (id, order_date, status, voided_at, total_amount, total_cny, currency) values
      ('${ids.completedUsd}', '2026-03-08', 'completed', null, 100, 700, 'USD'),
      ('${ids.completedUnpriced}', '2026-03-09', 'completed', null, 200, null, 'USD'),
      ('${ids.completedOut}', '2026-02-09', 'completed', null, 150, 900, 'USD'),
      ('${ids.submittedUsd}', '2026-03-10', 'submitted', null, 50, 350, 'USD'),
      ('${ids.approvedCny}', '2026-03-11', 'approved', null, 20, 20, 'CNY'),
      ('${ids.draft}', '2026-03-12', 'draft', null, 999, 999, 'USD'),
      ('${ids.voidedCompleted}', '2026-03-13', 'completed', '2026-03-14T00:00:00Z', 400, 400, 'USD');

    insert into public.finance_transactions
      (transaction_type, transaction_date, amount_cny, status) values
      ('income', '2026-03-03', 200, 'active'),
      ('expense', '2026-03-04', 80, 'active'),
      ('income', '2026-01-03', 999, 'active'),
      ('income', '2026-03-05', 777, 'void');

    insert into public.business_customer_transfers
      (id, received_at, exchange_rate_to_cny, voided_at) values
      ('${ids.transfer}', '2026-03-10T02:00:00Z', 7, null);

    insert into public.business_order_payment_allocations
      (order_id, transfer_id, amount, voided_at) values
      ('${ids.completedUsd}', '${ids.transfer}', 10, null);

    insert into public.finance_order_costs
      (finance_order_id, business_order_id, amount_cny) values
      ('${ids.legacyIn}', null, 150),
      ('${ids.legacyVoid}', null, 500),
      ('${ids.legacyOut}', null, 900),
      (null, '${ids.completedUsd}', 100),
      (null, '${ids.completedUnpriced}', 50),
      (null, '${ids.completedOut}', 999),
      (null, '${ids.submittedUsd}', 77);

    insert into public.business_order_finance_details (order_id, wage_amount_cny) values
      ('${ids.completedUsd}', 30),
      ('${ids.submittedUsd}', 40);
  `)

  const ranged = await db.query(
    `select * from public.get_finance_overview('2026-03-01'::date, '2026-03-31'::date)`,
  )
  assert.equal(ranged.rows.length, 1)
  const row = ranged.rows[0]
  assert.equal(Number(row.order_revenue), 1700, '订单业绩只计区间内已完成且未作废订单')
  assert.equal(Number(row.income), 270, '现金收入=日记账收入+客户转账折合')
  assert.equal(Number(row.expense), 80)
  assert.equal(Number(row.order_costs), 330, '成本只归集已完成订单与有效旧订单')
  assert.equal(Number(row.gross_profit), 1370)
  assert.equal(Number(row.cash_balance), 190)
  assert.equal(Number(row.completed_order_count), 2, '已完成订单数不含缺汇率订单之外的作废/区间外订单')
  assert.equal(Number(row.in_progress_order_count), 2, '进行中只算 submitted/approved')
  assert.equal(Number(row.unpriced_completed_order_count), 1)
  assert.deepEqual(row.in_progress_totals, { USD: 50, CNY: 20 })

  const all = await db.query(`select * from public.get_finance_overview()`)
  const allRow = all.rows[0]
  assert.equal(Number(allRow.order_revenue), 4600)
  assert.equal(Number(allRow.income), 1269)
  assert.equal(Number(allRow.expense), 80)
  assert.equal(Number(allRow.order_costs), 2229)
  assert.equal(Number(allRow.gross_profit), 2371)
  assert.equal(Number(allRow.cash_balance), 1189)
  assert.equal(Number(allRow.completed_order_count), 3)
  assert.equal(Number(allRow.in_progress_order_count), 2)

  // 现金趋势：最近 6 个月，收入含转账，支出取日记账。
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
      ('30000000-0000-4000-8000-000000000002', now(), 7, null);
    insert into public.business_order_payment_allocations
      (order_id, transfer_id, amount, voided_at) values
      ('${ids.completedUsd}', '30000000-0000-4000-8000-000000000002', 10, null);
  `)
  const trend2 = await db.query(`select * from public.get_finance_cash_trend(6)`)
  const latest = trend2.rows.at(-1)
  assert.equal(Number(latest.income), 570)
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
  console.log('verify-0144: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
