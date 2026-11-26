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
    path.join(__dirname, '../supabase/migrations/0166_customer_order_stats_repurchase.sql'),
    'utf8',
  )
  await db.exec(migration)
  // 可重复执行
  await db.exec(migration)

  const customers = {
    fullMix: '10000000-0000-4000-8000-000000000001',
    sampleOnly: '10000000-0000-4000-8000-000000000002',
    noOrders: '10000000-0000-4000-8000-000000000003',
  }

  await db.exec(`
    insert into public.business_orders
      (id, customer_id, order_date, status, fulfillment_type, voided_at,
       total_amount, total_cny, currency, exchange_rate_to_cny) values
      -- fullMix：近一年内 7 单有效（300/250/200/100/60/30/10 天前）
      ('20000000-0000-4000-8000-000000000001', '${customers.fullMix}', current_date - 400, 'approved', 'stock', null, 100, 700, 'USD', 7),
      ('20000000-0000-4000-8000-000000000002', '${customers.fullMix}', current_date - 300, 'approved', 'stock', null, 20, 140, 'USD', 7),
      ('20000000-0000-4000-8000-000000000003', '${customers.fullMix}', current_date - 250, 'approved', 'stock', null, 30, 210, 'USD', 7),
      ('20000000-0000-4000-8000-000000000004', '${customers.fullMix}', current_date - 200, 'approved', 'stock', null, 40, 280, 'USD', 7),
      ('20000000-0000-4000-8000-000000000005', '${customers.fullMix}', current_date - 150, 'approved', 'stock', '2026-01-01T00:00:00Z', 50, 350, 'USD', 7),
      ('20000000-0000-4000-8000-000000000006', '${customers.fullMix}', current_date - 120, 'submitted', 'stock', null, 60, 420, 'USD', 7),
      ('20000000-0000-4000-8000-000000000007', '${customers.fullMix}', current_date - 100, 'approved', 'stock', null, 70, 490, 'USD', 7),
      ('20000000-0000-4000-8000-000000000008', '${customers.fullMix}', current_date - 60, 'approved', 'stock', null, 80, 560, 'USD', 7),
      ('20000000-0000-4000-8000-000000000009', '${customers.fullMix}', current_date - 30, 'completed', 'stock', null, 500, 500, 'CNY', 1),
      ('20000000-0000-4000-8000-00000000000a', '${customers.fullMix}', current_date - 10, 'approved', 'custom', null, 90, 90, 'CNY', 1),
      -- sampleOnly：两单都是样品，但仍计入下单频次
      ('30000000-0000-4000-8000-000000000001', '${customers.sampleOnly}', current_date - 80, 'approved', 'stock', null, 10, 70, 'USD', 7),
      ('30000000-0000-4000-8000-000000000002', '${customers.sampleOnly}', current_date - 40, 'completed', 'stock', null, 10, 70, 'USD', 7);

    insert into public.business_order_items (order_id, daily_shipping_category) values
      ('20000000-0000-4000-8000-000000000002', 'stock'),
      ('20000000-0000-4000-8000-000000000003', 'custom_sample'),
      ('20000000-0000-4000-8000-000000000004', 'sample'),
      ('20000000-0000-4000-8000-000000000008', 'stock'),
      ('20000000-0000-4000-8000-000000000009', 'purchase'),
      ('20000000-0000-4000-8000-00000000000a', 'custom'),
      ('30000000-0000-4000-8000-000000000001', 'sample'),
      ('30000000-0000-4000-8000-000000000002', 'custom_sample');
  `)

  const { rows } = await db.query(
    `select * from public.get_customer_order_stats(
       array['${customers.fullMix}', '${customers.sampleOnly}', '${customers.noOrders}']::uuid[]
     )`,
  )
  assert.equal(rows.length, 2, '没有订单的客户不返回行')

  const mix = rows.find((row) => row.customer_id === customers.fullMix)
  assert.ok(mix, 'fullMix 客户有统计行')
  assert.equal(
    Number(mix.last_year_order_count),
    7,
    '近一年 7 单：400 天前、作废单、未审核单各 1 单排除',
  )
  assert.equal(Number(mix.deal_order_count), 4, '成交单数口径不变（纯样品/打样、无明细都不计）')
  assert.equal(Number(mix.custom_order_count), 1, '定制订单数口径不变')
  assert.equal(Number(mix.last_year_amount_cny), 2270, '近一年金额口径不变')
  assert.equal(
    Number(mix.avg_order_interval_days),
    56,
    '平均下单间隔：全部有效 8 单跨 390 天，390/7≈55.7 四舍五入 56',
  )

  const sampleOnly = rows.find((row) => row.customer_id === customers.sampleOnly)
  assert.ok(sampleOnly)
  assert.equal(Number(sampleOnly.last_year_order_count), 2, '样品单计入复购频率')
  assert.equal(Number(sampleOnly.deal_order_count), 0, '样品不计成交')
  assert.equal(Number(sampleOnly.avg_order_interval_days), 40, '两单跨 40 天，平均间隔 40 天')

  const grants = await db.query(`
    select
      has_function_privilege('authenticated', 'public.get_customer_order_stats(uuid[])', 'execute') as auth,
      has_function_privilege('anon', 'public.get_customer_order_stats(uuid[])', 'execute') as anon
  `)
  assert.equal(grants.rows[0].auth, true)
  assert.equal(grants.rows[0].anon, false)

  await db.close()
  console.log('0166 customer repurchase verification passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
