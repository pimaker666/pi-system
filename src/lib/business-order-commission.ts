import type { BusinessOrderCommissionRow } from '@/types'

export interface BusinessOrderCommissionFilters {
  q: string
  dateFrom?: string
  dateTo?: string
  shippingDateFrom?: string
  shippingDateTo?: string
  month?: string
  shops: string[]
  salespeople: string[]
  shopGroups: string[]
  page: number
}

export const BUSINESS_ORDER_COMMISSION_COLUMNS = [
  '客户', '发货分类', '产品图片', '产品名称', '产品实收金额', '产品提点', '产品提成',
  '运费实收金额', '运费成本', '运费利润', '运费提成', '提成结清状态',
] as const

export const COMMISSION_PAGE_SIZE = 50

function scalar(raw: Record<string, string | string[] | undefined>, key: string) {
  const value = raw[key]
  return Array.isArray(value) ? value[0] : value
}

function array(raw: Record<string, string | string[] | undefined>, key: string): string[] {
  const value = raw[key]
  if (value == null) return []
  return Array.isArray(value) ? value : value.split(',').filter(Boolean)
}

export function parseBusinessOrderCommissionFilters(
  raw: Record<string, string | string[] | undefined>,
): BusinessOrderCommissionFilters {
  return {
    q: scalar(raw, 'q') ?? '',
    dateFrom: scalar(raw, 'dateFrom') || undefined,
    dateTo: scalar(raw, 'dateTo') || undefined,
    shippingDateFrom: scalar(raw, 'shippingDateFrom') || undefined,
    shippingDateTo: scalar(raw, 'shippingDateTo') || undefined,
    month: scalar(raw, 'month') || undefined,
    shops: array(raw, 'shops'),
    salespeople: array(raw, 'salespeople'),
    shopGroups: array(raw, 'shopGroups'),
    page: Math.max(1, Number(scalar(raw, 'page') || 1) || 1),
  }
}

export function businessOrderCommissionFilterQuery(filters: BusinessOrderCommissionFilters) {
  const params = new URLSearchParams()
  if (filters.q) params.set('q', filters.q)
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom)
  if (filters.dateTo) params.set('dateTo', filters.dateTo)
  if (filters.shippingDateFrom) params.set('shippingDateFrom', filters.shippingDateFrom)
  if (filters.shippingDateTo) params.set('shippingDateTo', filters.shippingDateTo)
  if (filters.month) params.set('month', filters.month)
  filters.shops.forEach((id) => params.append('shops', id))
  filters.salespeople.forEach((id) => params.append('salespeople', id))
  filters.shopGroups.forEach((id) => params.append('shopGroups', id))
  if (filters.page && filters.page > 1) params.set('page', String(filters.page))
  return params.toString()
}

export function formatCommissionRate(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value)
}

const commissionAmountFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

// 提成板块（明细表、月度总览）金额统一保留 2 位小数，四舍五入。
export function formatCommissionAmount(value: number | null | undefined) {
  const amount = Number(value)
  if (value == null || !Number.isFinite(amount)) return '—'
  return `CNY ${commissionAmountFormat.format(amount)}`
}

export interface CommissionSummaryTotal {
  salespersonName: string
  period: string
  productAmount: number
  freightAmount: number
  missingRateCount: number
}

/**
 * 按「业务员 + 结清归属月」汇总已结清提成。
 *
 * 服务端对全量已结清行调用一次，只把汇总结果下发给浏览器——已结清行动辄上千条，
 * 把整批明细塞进 RSC 载荷只为了前端再算一遍总览，外网打开会明显变慢。
 * 美元行按结清时锁定的汇率折算，缺汇率的行只计入 missingRateCount；
 * 运费提成只取订单首行，避免同一订单多行重复计算运费利润。
 */
export function summarizeCommissionByPeriod(
  rows: BusinessOrderCommissionRow[],
): CommissionSummaryTotal[] {
  const totals = new Map<string, CommissionSummaryTotal>()
  for (const row of rows) {
    if (!row.clearance_period) continue
    const key = `${row.salesperson_name}\u0000${row.clearance_period}`
    const total = totals.get(key) ?? {
      salespersonName: row.salesperson_name,
      period: row.clearance_period,
      productAmount: 0,
      freightAmount: 0,
      missingRateCount: 0,
    }
    const rate = row.currency === 'USD' ? row.settlement_exchange_rate_to_cny : 1
    if (rate == null) {
      total.missingRateCount += 1
    } else {
      total.productAmount += row.product_commission_amount * rate
      if (row.is_order_lead_row) {
        const freightProfit = row.freight_received_amount * rate - row.freight_cost
        total.freightAmount += Math.round(((freightProfit * row.freight_commission_rate) / 100) * 10000) / 10000
      }
    }
    totals.set(key, total)
  }
  return [...totals.values()].sort(
    (left, right) =>
      right.period.localeCompare(left.period) ||
      left.salespersonName.localeCompare(right.salespersonName, 'zh-CN'),
  )
}
