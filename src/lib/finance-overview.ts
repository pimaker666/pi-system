import type { CurrencyCode } from '@/types'
import { getBusinessDateKey } from './business-orders.ts'

export const FINANCE_OVERVIEW_RANGES = [
  { value: 'month', label: '本月' },
  { value: 'quarter', label: '本季' },
  { value: 'year', label: '本年' },
  { value: 'all', label: '全部' },
] as const

export type FinanceOverviewRange = (typeof FINANCE_OVERVIEW_RANGES)[number]['value']

export interface FinanceOverviewSummary {
  orderRevenue: number
  income: number
  expense: number
  orderCosts: number
  grossProfit: number
  cashBalance: number
  completedOrderCount: number
  inProgressOrderCount: number
  inProgressTotals: { currency: CurrencyCode; amount: number }[]
  unpricedCompletedOrderCount: number
}

interface FinanceOverviewRow {
  order_revenue: number | string | null
  income: number | string | null
  expense: number | string | null
  order_costs: number | string | null
  gross_profit: number | string | null
  cash_balance: number | string | null
  completed_order_count: number | string | null
  in_progress_order_count: number | string | null
  in_progress_totals: Record<string, number | string> | null
  unpriced_completed_order_count: number | string | null
}

export function parseFinanceOverviewRange(
  value: string | string[] | undefined,
): FinanceOverviewRange {
  const raw = Array.isArray(value) ? value[0] : value
  return FINANCE_OVERVIEW_RANGES.some((option) => option.value === raw)
    ? (raw as FinanceOverviewRange)
    : 'month'
}

/** 区间按北京时间取「本期累计」：本月/本季/本年都截止今天，避免把未来日期带进筛选。 */
export function resolveFinanceOverviewRange(
  range: FinanceOverviewRange,
  reference = new Date(),
): { from: string | null; to: string | null; label: string } {
  const label = FINANCE_OVERVIEW_RANGES.find((option) => option.value === range)?.label ?? '本月'
  if (range === 'all') return { from: null, to: null, label }

  const today = getBusinessDateKey(reference)
  const [year, month] = today.split('-').map(Number)
  const pad = (value: number) => String(value).padStart(2, '0')

  if (range === 'year') return { from: `${year}-01-01`, to: today, label }
  if (range === 'quarter') {
    const startMonth = Math.floor((month - 1) / 3) * 3 + 1
    return { from: `${year}-${pad(startMonth)}-01`, to: today, label }
  }
  return { from: `${year}-${pad(month)}-01`, to: today, label }
}

export function mapFinanceOverviewRow(row: FinanceOverviewRow): FinanceOverviewSummary {
  const totals = row.in_progress_totals ?? {}
  return {
    orderRevenue: Number(row.order_revenue ?? 0),
    income: Number(row.income ?? 0),
    expense: Number(row.expense ?? 0),
    orderCosts: Number(row.order_costs ?? 0),
    grossProfit: Number(row.gross_profit ?? 0),
    cashBalance: Number(row.cash_balance ?? 0),
    completedOrderCount: Number(row.completed_order_count ?? 0),
    inProgressOrderCount: Number(row.in_progress_order_count ?? 0),
    inProgressTotals: Object.entries(totals)
      .map(([currency, amount]) => ({
        currency: currency as CurrencyCode,
        amount: Number(amount),
      }))
      .filter((entry) => entry.amount > 0)
      .sort((a, b) => b.amount - a.amount),
    unpricedCompletedOrderCount: Number(row.unpriced_completed_order_count ?? 0),
  }
}
