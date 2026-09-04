import type {
  CurrencyCode,
  DailyOrder,
  DailyOrderChangeStatus,
  DailyOrderPaymentCategory,
  DailyOrderShippingCategory,
  DailyOrderShop,
  DailyOrderWorkflowStatus,
  Product,
  Profile,
} from '@/types'
import { dailyOrderFilterSchema, dailyOrderSchema, type DailyOrderFilters, type DailyOrderInput } from '@/schemas/daily-order'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'muted'

export const DAILY_ORDER_COLUMNS = [
  '序号', '下单日期', '店铺', '业务员', '订单号', '发货日期', '发货单号', '发货分类',
  '产品名称', '数量', '销售单价', '产品实收金额', '物流费用', '销售总金额', '收款分类', '备注', '截图',
] as const

export const SHIPPING_LABELS: Record<DailyOrderShippingCategory, string> = {
  stock: '现货', sample: '样品', custom: '定制',
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
  logistics_fee_amount: '物流费用',
  logistics_fee_currency: '物流费用币种',
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

export function sumDailyOrdersByCurrency(rows: DailyOrder[], field: 'product_received' | 'logistics_fee' | 'sales_total') {
  return rows.reduce<Record<'CNY' | 'USD', number>>((totals, row) => {
    const currency = row[`${field}_currency`] as 'CNY' | 'USD'
    totals[currency] += Number(row[`${field}_amount`])
    return totals
  }, { CNY: 0, USD: 0 })
}

const HEADER_ALIASES: Record<keyof DailyOrderInput, string[]> = {
  order_date: ['下单日期', '订单日期', 'order_date', 'order date'],
  shop_id: ['店铺', '店铺名称', 'shop', 'shop_name'],
  salesperson_id: ['业务员', '销售员', 'salesperson', 'sales'],
  order_number: ['订单号', '单号', 'order_number', 'order no', 'order number'],
  shipping_date: ['发货日期', '出货日期', 'shipping_date', 'shipping date'],
  shipping_number: ['发货单号', '物流单号', '快递单号', 'shipping_number', 'tracking number'],
  shipping_category: ['发货分类', '发货类型', 'shipping_category', 'shipping category'],
  product_id: ['产品名称', '产品', 'sku', 'product', 'product_name'],
  quantity: ['数量', 'qty', 'quantity'],
  sales_unit_price_amount: ['销售单价', '单价', 'sales_unit_price', 'unit price'],
  sales_unit_price_currency: ['销售单价币种', '单价币种', 'sales_unit_price_currency'],
  product_received_amount: ['产品实收金额', '实收金额', 'product_received_amount'],
  product_received_currency: ['产品实收币种', '实收币种', 'product_received_currency'],
  logistics_fee_amount: ['物流费用', '运费', 'logistics_fee'],
  logistics_fee_currency: ['物流费用币种', '物流币种', 'logistics_fee_currency'],
  sales_total_amount: ['销售总金额', '销售总额', 'sales_total_amount', 'total amount'],
  sales_total_currency: ['销售总金额币种', '总金额币种', 'sales_total_currency'],
  payment_category: ['收款分类', '收款类型', 'payment_category', 'payment category'],
  remarks: ['备注', '说明', 'remarks', 'notes'],
}

function normalizedHeader(value: unknown) {
  return String(value ?? '').trim().toLocaleLowerCase().replace(/[\s_-]+/g, '')
}

const aliasIndex = Object.fromEntries(
  Object.entries(HEADER_ALIASES).flatMap(([key, aliases]) => aliases.map((alias) => [normalizedHeader(alias), key])),
) as Record<string, keyof DailyOrderInput>

function parseDateValue(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  if (typeof value === 'number' && value > 0) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000)
    return date.toISOString().slice(0, 10)
  }
  const text = String(value ?? '').trim()
  if (!text) return ''
  const normalized = text.replace(/[./]/g, '-')
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString().slice(0, 10)
}

function parseMoney(value: unknown): { amount: string; currency: 'CNY' | 'USD' | '' } {
  const text = String(value ?? '').trim()
  const currency = /USD|US\$|美元/i.test(text) ? 'USD' : /CNY|RMB|人民币|¥|￥/i.test(text) ? 'CNY' : ''
  return { amount: text.replace(/CNY|RMB|USD|US\$|人民币|美元|[¥￥,$，\s]/gi, ''), currency }
}

function shippingValue(value: unknown): DailyOrderShippingCategory | '' {
  const text = normalizedHeader(value)
  if (['stock', '现货'].includes(text)) return 'stock'
  if (['sample', '样品', '样板'].includes(text)) return 'sample'
  if (['custom', '定制'].includes(text)) return 'custom'
  return ''
}

function paymentValue(value: unknown): DailyOrderPaymentCategory | '' {
  const text = normalizedHeader(value)
  if (['full', '全款'].includes(text)) return 'full'
  if (['deposit', '定金'].includes(text)) return 'deposit'
  if (['balance', '尾款', '余款'].includes(text)) return 'balance'
  return ''
}

export interface DailyOrderImportReference {
  shops: Array<DailyOrderShop & { salespersonIds?: string[] }>
  salespeople: Pick<Profile, 'id' | 'full_name' | 'email'>[]
  products: Pick<Product, 'id' | 'name' | 'sku'>[]
}

export interface DailyOrderImportRow extends Record<string, unknown> {
  rowNumber: number
  errors: string[]
}

export const DAILY_ORDER_EXPORT_MAX_IMAGES = 100
export const DAILY_ORDER_EXPORT_MAX_IMAGE_BYTES = 50 * 1024 * 1024

export function validateDailyOrderImportRow(row: DailyOrderImportRow, refs: DailyOrderImportReference) {
  const errors: string[] = []
  const validation = dailyOrderSchema.safeParse(row)
  if (!validation.success) errors.push(...validation.error.issues.map((issue) => issue.message))

  const shop = refs.shops.find((item) => item.id === row.shop_id && item.is_active)
  if (row.shop_id && !shop) errors.push('店铺不存在或已停用')
  if (row.salesperson_id && !refs.salespeople.some((person) => person.id === row.salesperson_id)) {
    errors.push('业务员不存在或未审核')
  } else if (row.salesperson_id && !shop?.salespersonIds?.includes(String(row.salesperson_id))) {
    errors.push('所选业务员未分配到该店铺')
  }
  if (row.product_id && !refs.products.some((product) => product.id === row.product_id)) {
    errors.push('产品不存在或已停用')
  }
  return [...new Set(errors)]
}

export function dailyOrderExportLimitError(rows: DailyOrder[]) {
  const screenshots = rows.flatMap((row) =>
    (row.finance_daily_order_screenshots ?? []).filter((screenshot) => screenshot.status === 'active').slice(0, 10),
  )
  const totalBytes = screenshots.reduce((sum, screenshot) => sum + Number(screenshot.size_bytes), 0)
  if (screenshots.length > DAILY_ORDER_EXPORT_MAX_IMAGES) {
    return `筛选结果包含 ${screenshots.length} 张截图，单次最多导出 ${DAILY_ORDER_EXPORT_MAX_IMAGES} 张，请缩小筛选范围`
  }
  if (totalBytes > DAILY_ORDER_EXPORT_MAX_IMAGE_BYTES) {
    return '筛选结果的截图总大小超过 50MB，请缩小筛选范围'
  }
  return null
}

export function mapDailyOrderImportRows(matrix: unknown[][], refs: DailyOrderImportReference): DailyOrderImportRow[] {
  if (matrix.length < 2) return []
  const fields = matrix[0].map((heading) => aliasIndex[normalizedHeader(heading)] ?? null)
  return matrix.slice(1, 501).filter((row) => row.some((cell) => String(cell ?? '').trim())).map((row, index) => {
    const raw: Partial<Record<keyof DailyOrderInput, unknown>> = {}
    fields.forEach((field, col) => { if (field && raw[field] === undefined) raw[field] = row[col] })
    const shopText = String(raw.shop_id ?? '').trim().toLocaleLowerCase()
    const salesText = String(raw.salesperson_id ?? '').trim().toLocaleLowerCase()
    const productText = String(raw.product_id ?? '').trim().toLocaleLowerCase()
    const shop = refs.shops.find((item) => item.name.trim().toLocaleLowerCase() === shopText)
    const assignedIds = new Set(shop?.salespersonIds ?? refs.salespeople.map((person) => person.id))
    const salespersonMatches = refs.salespeople.filter((item) =>
      assignedIds.has(item.id) && [item.full_name, item.email].some((name) => name?.trim().toLocaleLowerCase() === salesText))
    const salesperson = salespersonMatches.length === 1 ? salespersonMatches[0] : undefined
    const product = refs.products.find((item) =>
      item.name.trim().toLocaleLowerCase() === productText || item.sku.trim().toLocaleLowerCase() === productText)
    const unit = parseMoney(raw.sales_unit_price_amount)
    const received = parseMoney(raw.product_received_amount)
    const logistics = parseMoney(raw.logistics_fee_amount)
    const total = parseMoney(raw.sales_total_amount)
    const shippingText = String(raw.shipping_category ?? '').trim()
    const paymentText = String(raw.payment_category ?? '').trim()
    const result: DailyOrderImportRow = {
      rowNumber: index + 2,
      order_date: parseDateValue(raw.order_date),
      shop_id: shop?.id ?? '', shop_name: String(raw.shop_id ?? ''),
      salesperson_id: salesperson?.id ?? '', salesperson_name: String(raw.salesperson_id ?? ''),
      order_number: String(raw.order_number ?? '').trim(),
      shipping_date: parseDateValue(raw.shipping_date || raw.order_date),
      shipping_number: String(raw.shipping_number ?? '').trim(),
      shipping_category: shippingText ? shippingValue(raw.shipping_category) : 'stock',
      product_id: product?.id ?? '', product_name: String(raw.product_id ?? ''),
      quantity: String(raw.quantity ?? '').replace(/,/g, ''),
      sales_unit_price_amount: unit.amount,
      sales_unit_price_currency: String(raw.sales_unit_price_currency || unit.currency || 'CNY').toUpperCase(),
      product_received_amount: received.amount,
      product_received_currency: String(raw.product_received_currency || received.currency || 'CNY').toUpperCase(),
      logistics_fee_amount: logistics.amount,
      logistics_fee_currency: String(raw.logistics_fee_currency || logistics.currency || 'CNY').toUpperCase(),
      sales_total_amount: total.amount,
      sales_total_currency: String(raw.sales_total_currency || total.currency || 'CNY').toUpperCase(),
      payment_category: paymentText ? paymentValue(raw.payment_category) : 'full',
      remarks: String(raw.remarks ?? '').trim(),
      errors: [],
    }
    if (!shop) result.errors.push('店铺未精确匹配')
    if (!salesperson) result.errors.push('业务员未精确匹配或匹配不唯一')
    if (!product) result.errors.push('产品未精确匹配')
    const validation = dailyOrderSchema.safeParse(result)
    if (!validation.success) {
      result.errors.push(...validation.error.issues.map((issue) => issue.message))
    }
    result.errors = [...new Set(result.errors)]
    return result
  })
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
