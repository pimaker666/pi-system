import type { BusinessOrderCostFilters } from '@/schemas/business-order-cost'

export const BUSINESS_ORDER_COST_COLUMNS = [
  '序号', '下单日期', '店铺', '业务员', '订单号', '发货日期', '收款账户', '发货分类',
  '产品图片', '产品名称', '数量', '成本(元)', '总成本(元)', '发货进度', '销售单价', '产品实收金额', '运费实收金额',
  '订单总金额', '未收尾款', '收款分类', '备注', '截图',
] as const

export const COST_PAGE_SIZE = 50
export const PERFORMANCE_PAGE_SIZE = 50

function scalar(raw: Record<string, string | string[] | undefined>, key: string) {
  const value = raw[key]
  return Array.isArray(value) ? value[0] : value
}

function array(raw: Record<string, string | string[] | undefined>, key: string): string[] {
  const value = raw[key]
  if (value == null) return []
  return Array.isArray(value) ? value : value.split(',').filter(Boolean)
}

export function parseBusinessOrderCostFilters(
  raw: Record<string, string | string[] | undefined>,
): BusinessOrderCostFilters {
  return {
    q: scalar(raw, 'q') ?? '',
    dateFrom: scalar(raw, 'dateFrom') || undefined,
    dateTo: scalar(raw, 'dateTo') || undefined,
    month: scalar(raw, 'month') || undefined,
    shops: array(raw, 'shops'),
    salespeople: array(raw, 'salespeople'),
    shopGroups: array(raw, 'shopGroups'),
    page: Math.max(1, Number(scalar(raw, 'page') || 1) || 1),
  }
}

export function businessOrderCostFilterQuery(filters: BusinessOrderCostFilters) {
  const params = new URLSearchParams()
  if (filters.q) params.set('q', filters.q)
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom)
  if (filters.dateTo) params.set('dateTo', filters.dateTo)
  if (filters.month) params.set('month', filters.month)
  filters.shops.forEach((id) => params.append('shops', id))
  filters.salespeople.forEach((id) => params.append('salespeople', id))
  filters.shopGroups.forEach((id) => params.append('shopGroups', id))
  if (filters.page && filters.page > 1) params.set('page', String(filters.page))
  return params.toString()
}

export function formatCostValue(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value)
}
