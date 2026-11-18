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

    create type public.business_order_status as enum (
      'draft', 'submitted', 'rejected', 'approved', 'completed'
    );
    create type public.currency_code as enum ('USD', 'CNY');

    create table public.business_orders (
      id uuid primary key default gen_random_uuid(),
      customer_id uuid,
      order_date date not null,
      status public.business_order_status not null,
      fulfillment_type text not null default 'stock',
      voided_at timestamptz,
      total_amount numeric not null default 0,
      total_cny numeric,
      currency public.currency_code not null default 'USD',
      exchange_rate_to_cny numeric
    );

    create table public.business_order_items (
      id uuid primary key default gen_random_uuid(),
      order_id uuid not null,
      daily_shipping_category text
    );
  `)

  const migration = fs.readFileSync(
    path.join(__dirname, '../supabase/migrations/0151_customer_tenure_and_deal_orders.sql'),
    'utf8',
  )
  await db.exec(migration)

  const customers = {
    fullMix: '10000000-0000-4000-8000-000000000001',
    sampleOnly: '10000000-0000-4000-8000-000000000002',
    noOrders: '10000000-0000-4000-8000-000000000003',
  }

  const orders = {
    oldStock: '20000000-0000-4000-8000-000000000001',
    sampleOnly: '20000000-0000-4000-8000-000000000002',
    customSampleOnly: '20000000-0000-4000-8000-000000000003',
    mixedSampleStock: '20000000-0000-4000-8000-000000000004',
    voidedStock: '20000000-0000-4000-8000-000000000005',
    submittedStock: '20000000-0000-4000-8000-000000000006',
    noItems: '20000000-0000-4000-8000-000000000007',
    unclassifiedItem: '20000000-0000-4000-8000-000000000008',
    recentCny: '20000000-0000-4000-8000-000000000009',
    customDeal: '20000000-0000-4000-8000-00000000000a',
  }

  await db.exec(`
    insert into public.business_orders
      (id, customer_id, order_date, status, fulfillment_type, voided_at,
       total_amount, total_cny, currency, exchange_rate_to_cny) values
      ('${orders.oldStock}', '${customers.fullMix}', current_date - 400, 'approved', 'stock', null, 100, 700, 'USD', 7),
      ('${orders.sampleOnly}', '${customers.fullMix}', current_date - 300, 'approved', 'stock', null, 20, 140, 'USD', 7),
      ('${orders.customSampleOnly}', '${customers.fullMix}', current_date - 250, 'approved', 'stock', null, 30, 210, 'USD', 7),
      ('${orders.mixedSampleStock}', '${customers.fullMix}', current_date - 200, 'approved', 'stock', null, 40, 280, 'USD', 7),
      ('${orders.voidedStock}', '${customers.fullMix}', current_date - 150, 'approved', 'stock', '2026-01-01T00:00:00Z', 50, 350, 'USD', 7),
      ('${orders.submittedStock}', '${customers.fullMix}', current_date - 120, 'submitted', 'stock', null, 60, 420, 'USD', 7),
      ('${orders.noItems}', '${customers.fullMix}', current_date - 100, 'approved', 'stock', null, 70, 490, 'USD', 7),
      ('${orders.unclassifiedItem}', '${customers.fullMix}', current_date - 60, 'approved', 'stock', null, 80, 560, 'USD', 7),
      ('${orders.recentCny}', '${customers.fullMix}', current_date - 30, 'completed', 'stock', null, 500, 500, 'CNY', 1),
      ('${orders.customDeal}', '${customers.fullMix}', current_date - 10, 'approved', 'custom', null, 90, 90, 'CNY', 1),
      ('30000000-0000-4000-8000-000000000001', '${customers.sampleOnly}', current_date - 80, 'approved', 'stock', null, 10, 70, 'USD', 7),
      ('30000000-0000-4000-8000-000000000002', '${customers.sampleOnly}', current_date - 40, 'completed', 'stock', null, 10, 70, 'USD', 7);

    insert into public.business_order_items (order_id, daily_shipping_category) values
      ('${orders.oldStock}', 'stock'),
      ('${orders.sampleOnly}', 'sample'),
      ('${orders.customSampleOnly}', 'custom_sample'),
      ('${orders.mixedSampleStock}', 'sample'),
      ('${orders.mixedSampleStock}', 'stock'),
      ('${orders.voidedStock}', 'stock'),
      ('${orders.submittedStock}', 'stock'),
      ('${orders.unclassifiedItem}', null),
      ('${orders.recentCny}', 'purchase'),
      ('${orders.customDeal}', 'custom'),
      ('30000000-0000-4000-8000-000000000001', 'sample'),
      ('30000000-0000-4000-8000-000000000002', 'custom_sample');
  `)

  const result = await db.query(
    `select * from public.get_customer_order_stats(
       array['${customers.fullMix}', '${customers.sampleOnly}', '${customers.noOrders}']::uuid[]
     )`,
  )
  assert.equal(result.rows.length, 2, '没有订单的客户不返回行')

  const mix = result.rows.find((row) => row.customer_id === customers.fullMix)
  assert.ok(mix, 'fullMix 客户有统计行')
  const expectedFirst = (await db.query(`select (current_date - 400)::date as d`)).rows[0].d
  const expectedLast = (await db.query(`select (current_date - 10)::date as d`)).rows[0].d
  assert.equal(new Date(mix.first_order_date).toISOString(), new Date(expectedFirst).toISOString(), '客户年限取最早的有效订单日期（含样品单）')
  assert.equal(new Date(mix.last_order_date).toISOString(), new Date(expectedLast).toISOString())
  assert.equal(
    Number(mix.deal_order_count),
    5,
    '成交单数：现货/混合/未填分类/外采/定制各 1 单，纯样品、纯打样、作废、未审核、无明细都不计',
  )
  assert.equal(Number(mix.custom_order_count), 1, '定制订单数口径不变')
  assert.equal(Number(mix.last_year_amount_cny), 2270, '近一年人民币金额口径不变（含 400 天前排除与已填汇率折算）')
  assert.equal(Number(mix.last_year_amount_usd), 0, '已填汇率的美元单折进人民币列')

  const sampleOnly = result.rows.find((row) => row.customer_id === customers.sampleOnly)
  assert.ok(sampleOnly)
  assert.equal(Number(sampleOnly.deal_order_count), 0, '只有样品/打样的客户成交单数为 0')
  assert.ok(sampleOnly.first_order_date, '但年限仍从第一张样品单起算')

  const grants = await db.query(`
    select
      has_function_privilege('authenticated', 'public.get_customer_order_stats(uuid[])', 'execute') as auth,
      has_function_privilege('anon', 'public.get_customer_order_stats(uuid[])', 'execute') as anon
  `)
  assert.equal(grants.rows[0].auth, true)
  assert.equal(grants.rows[0].anon, false)

  await db.close()
  console.log('verify-0151: all assertions passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
