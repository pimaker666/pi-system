import type {
  CurrencyCode,
  DailyOrderChangeStatus,
  DailyOrderPaymentCategory,
  DailyOrderShippingCategory,
  DailyOrderShop,
  DailyOrderWorkflowStatus,
} from '@/types'
import { dailyOrderFilterSchema, type DailyOrderFilters } from '@/schemas/daily-order'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'muted'

/** 店铺下拉选项：店铺本体 + 当前分配到该店铺的业务员 id 列表。 */
export interface DailyOrderShopOption extends DailyOrderShop {
  salespersonIds: string[]
}

export const DAILY_ORDER_COLUMNS = [
  '序号', '下单日期', '店铺', '业务员', '订单号', '发货日期', '发货单号', '发货分类',
  '产品名称', '数量', '销售单价', '产品实收金额', '运费实收金额', '销售总金额', '收款分类', '备注', '截图',
] as const

export const SHIPPING_LABELS: Record<DailyOrderShippingCategory, string> = {
  stock: '现货', sample: '样品', custom: '定制', purchase: '外采',
}
export const PAYMENT_LABELS: Record<DailyOrderPaymentCategory, string> = {
  full: '全款', deposit: '定金', balance: '尾款',
}

export const WORKFLOW_STATUS_LABELS: Record<DailyOrderWorkflowStatus, string> = {
  unclaimed: '待认领', claimed: '已认领', submitted: '待审核', approved: '已通过', rejected: '已驳回',
}
export const WORKFLOW_STATUS_VARIANTS: Record<DailyOrderWorkflowStatus, BadgeVariant> = {
  unclaimed: 'muted', claimed: 'secondary', submitted: 'default', approved: 'success', rejected: 'destructive',
}

export const CHANGE_STATUS_LABELS: Record<DailyOrderChangeStatus, string> = {
  pending: '待审核', approved: '已通过', rejected: '已驳回', cancelled: '已撤销',
}
export const CHANGE_STATUS_VARIANTS: Record<DailyOrderChangeStatus, BadgeVariant> = {
  pending: 'default', approved: 'success', rejected: 'destructive', cancelled: 'muted',
}

/** Chinese labels for whitelisted change-request payload keys (mirrors the DB whitelist). */
export const CHANGE_FIELD_LABELS: Record<string, string> = {
  shipping_date: '发货日期',
  shipping_number: '发货单号',
  shipping_category: '发货分类',
  quantity: '数量',
  sales_unit_price_amount: '销售单价',
  sales_unit_price_currency: '销售单价币种',
  product_received_amount: '产品实收金额',
  product_received_currency: '产品实收币种',
  logistics_fee_amount: '运费实收金额',
  logistics_fee_currency: '运费实收币种',
  sales_total_amount: '销售总金额',
  sales_total_currency: '销售总金额币种',
  payment_category: '收款分类',
  remarks: '备注',
}

export function formatDailyMoney(amount: number | string, currency: CurrencyCode) {
  return `${currency} ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function parseDailyOrderFilters(raw: Record<string, string | string[] | undefined>): DailyOrderFilters {
  const scalar = (key: string) => {
    const value = raw[key]
    return Array.isArray(value) ? value[0] : value
  }
  const parsed = dailyOrderFilterSchema.safeParse({
    q: scalar('q') || undefined,
    dateFrom: scalar('dateFrom') || undefined,
    dateTo: scalar('dateTo') || undefined,
    shop: scalar('shop') || undefined,
    salesperson: scalar('salesperson') || undefined,
    category: scalar('category') || undefined,
    payment: scalar('payment') || undefined,
  })
  return parsed.success ? parsed.data : { q: '' }
}

export function dailyOrderFilterQuery(filters: DailyOrderFilters) {
  const params = new URLSearchParams()
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value)
  })
  return params.toString()
}

export function parseDelimitedText(text: string): string[][] {
  const delimiter = text.includes('\t') ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '"' && quoted && text[i + 1] === '"') { cell += '"'; i += 1 }
    else if (char === '"') quoted = !quoted
    else if (char === delimiter && !quoted) { row.push(cell); cell = '' }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += char
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}
