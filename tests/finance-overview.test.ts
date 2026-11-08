import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  mapFinanceOverviewRow,
  parseFinanceOverviewRange,
  resolveFinanceOverviewRange,
} from '../src/lib/finance-overview.ts'

const REFERENCE = new Date('2026-11-08T04:00:00Z')

test('parseFinanceOverviewRange 只接受已知区间，默认本月', () => {
  assert.equal(parseFinanceOverviewRange(undefined), 'month')
  assert.equal(parseFinanceOverviewRange('quarter'), 'quarter')
  assert.equal(parseFinanceOverviewRange(['year']), 'year')
  assert.equal(parseFinanceOverviewRange('all'), 'all')
  assert.equal(parseFinanceOverviewRange('2026-01'), 'month')
})

test('resolveFinanceOverviewRange 按北京时间取本期累计', () => {
  assert.deepEqual(resolveFinanceOverviewRange('month', REFERENCE), {
    from: '2026-11-01',
    to: '2026-11-08',
    label: '本月',
  })
  assert.deepEqual(resolveFinanceOverviewRange('quarter', REFERENCE), {
    from: '2026-10-01',
    to: '2026-11-08',
    label: '本季',
  })
  assert.deepEqual(resolveFinanceOverviewRange('year', REFERENCE), {
    from: '2026-01-01',
    to: '2026-11-08',
    label: '本年',
  })
  assert.deepEqual(resolveFinanceOverviewRange('all', REFERENCE), {
    from: null,
    to: null,
    label: '全部',
  })
})

test('季度起始月覆盖四个季度', () => {
  const quarterStart = (date: string) =>
    resolveFinanceOverviewRange('quarter', new Date(`${date}T04:00:00Z`)).from
  assert.equal(quarterStart('2026-01-15'), '2026-01-01')
  assert.equal(quarterStart('2026-03-31'), '2026-01-01')
  assert.equal(quarterStart('2026-04-01'), '2026-04-01')
  assert.equal(quarterStart('2026-09-30'), '2026-07-01')
  assert.equal(quarterStart('2026-12-01'), '2026-10-01')
})

test('mapFinanceOverviewRow 归一数字并按金额排序进行中币种', () => {
  const summary = mapFinanceOverviewRow({
    order_revenue: '1700.5000',
    income: 270,
    expense: '80',
    order_costs: 330,
    gross_profit: '1370.5',
    cash_balance: 190,
    completed_order_count: '2',
    in_progress_order_count: 2,
    in_progress_totals: { USD: '50.0000', CNY: 20, EUR: 0 },
    unpriced_completed_order_count: 1,
  })

  assert.equal(summary.orderRevenue, 1700.5)
  assert.equal(summary.grossProfit, 1370.5)
  assert.equal(summary.completedOrderCount, 2)
  assert.equal(summary.inProgressOrderCount, 2)
  assert.equal(summary.unpricedCompletedOrderCount, 1)
  assert.deepEqual(summary.inProgressTotals, [
    { currency: 'USD', amount: 50 },
    { currency: 'CNY', amount: 20 },
  ])
})
