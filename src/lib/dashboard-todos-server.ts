import type { SupabaseClient } from '@supabase/supabase-js'
import type { CurrencyCode } from '@/types'
import type { DailyOrderFilters } from '@/schemas/daily-order'
import { fetchBusinessDailyLedgerSummary } from '@/lib/business-daily-orders-server'
import { parseDailyOrderFilters } from '@/lib/daily-orders'
import { getBusinessDateKey } from '@/lib/business-orders'

export interface DashboardCurrencyTotal {
  currency: CurrencyCode
  amount: number
}

export interface DashboardReceivableSummary {
  orderCount: number
  overdueCount: number
  totals: DashboardCurrencyTotal[]
}

export interface DashboardMonthOrderSummary {
  count: number
  totals: DashboardCurrencyTotal[]
}

/** 台账基础筛选（只保留正常订单），结算条件清空以免按「未结算」再筛一遍。 */
function baseLedgerFilters(): DailyOrderFilters {
  return { ...parseDailyOrderFilters({}), settlementStatuses: [] }
}

function monthDateKeys(reference = new Date()) {
  const today = getBusinessDateKey(reference)
  const month = today.slice(0, 7)
  const [year, monthNumber] = month.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return { dateFrom: `${month}-01`, dateTo: `${month}-${String(lastDay).padStart(2, '0')}` }
}

export function currentMonthDateRange(reference = new Date()) {
  return monthDateKeys(reference)
}

/** 工作台「未收尾款」：走台账 SQL 聚合，按币种返回 outstanding，销售只能看到自己范围内的订单。 */
export async function fetchDashboardReceivables(
  supabase: SupabaseClient,
  reference = new Date(),
): Promise<DashboardReceivableSummary> {
  const today = getBusinessDateKey(reference)
  const [ledger, overdue] = await Promise.all([
    fetchBusinessDailyLedgerSummary(
      supabase,
      { ...baseLedgerFilters(), balanceStatuses: ['unsettled'] },
      1,
      1,
    ),
    supabase
      .from('business_orders')
      .select('id', { count: 'exact', head: true })
      .is('voided_at', null)
      .neq('payment_status', 'fully_paid')
      .not('payment_due_date', 'is', null)
      .lt('payment_due_date', today),
  ])
  if (overdue.error) throw new Error(`逾期订单读取失败：${overdue.error.message}`)

  return {
    orderCount: ledger.totalCount,
    overdueCount: overdue.count ?? 0,
    totals: ledger.currencies
      .map((row) => ({ currency: row.currency, amount: row.outstanding }))
      .filter((row) => row.amount > 0),
  }
}

/** 工作台「本月订单」：订单日期落在本月，口径与台账总金额一致。 */
export async function fetchDashboardMonthOrders(
  supabase: SupabaseClient,
  reference = new Date(),
): Promise<DashboardMonthOrderSummary> {
  const { dateFrom, dateTo } = monthDateKeys(reference)
  const ledger = await fetchBusinessDailyLedgerSummary(
    supabase,
    { ...baseLedgerFilters(), dateFrom, dateTo },
    1,
    1,
  )
  return {
    count: ledger.totalCount,
    totals: ledger.currencies
      .map((row) => ({ currency: row.currency, amount: row.receivable }))
      .filter((row) => row.amount > 0),
  }
}

/** 待确认提成：与侧边栏角标同一口径，RLS 只返回本人待确认行。 */
export async function fetchDashboardPendingCommissionCount(
  supabase: SupabaseClient,
): Promise<number> {
  const { count, error } = await supabase
    .from('finance_business_order_item_commission_clearances')
    .select('business_order_item_id', { count: 'exact', head: true })
    .eq('status', 'pending')
  if (error) throw new Error(`提成提醒读取失败：${error.message}`)
  return count ?? 0
}
