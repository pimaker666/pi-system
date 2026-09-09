import {
  businessOrderDailyShippingCategories,
  businessOrderInputSchema,
  businessPaymentTypes,
  type BusinessOrderInput,
} from '@/schemas/business-order'
import { CURRENCIES } from '@/schemas/product'
import { roundToScale } from '@/lib/utils'
import type {
  Customer,
  CurrencyCode,
  DailyOrderPaymentCategory,
  DailyOrderShippingCategory,
  DailyOrderShop,
  Product,
  Profile,
} from '@/types'

/**
 * 每日订单批量导入（恢复版）。
 *
 * 与 0031 之前的旧导入相比有两点必须不同：
 * 1. 写入目标是 business_orders（经 create_business_order_v4），旧 finance_daily_* 保持冻结；
 * 2. 因此每行必须能定位客户，且同一订单号的多行会合并为一张订单的多条明细。
 */

export const BUSINESS_DAILY_IMPORT_COLUMNS = [
  '下单日期',
  '店铺',
  '业务员',
  '客户',
  '订单号',
  '发货日期',
  '发货单号',
  '发货分类',
  '产品名称',
  '数量',
  '销售单价',
  '产品实收金额',
  '运费实收金额',
  '销售总金额',
  '应收实收差额原因',
  '收款分类',
  '备注',
  '币种',
  '汇率',
] as const

export type BusinessDailyImportField =
  | 'order_date'
  | 'shop_id'
  | 'salesperson_id'
  | 'customer_id'
  | 'external_order_number'
  | 'daily_shipping_date'
  | 'daily_shipping_number'
  | 'daily_shipping_category'
  | 'product_id'
  | 'quantity'
  | 'unit_price'
  | 'product_received_amount'
  | 'logistics_fee_amount'
  | 'sales_total_amount'
  | 'receivable_received_difference_reason'
  | 'daily_payment_category'
  | 'sales_notes'
  | 'currency'
  | 'exchange_rate_to_cny'

const HEADER_ALIASES: Record<BusinessDailyImportField, string[]> = {
  order_date: ['下单日期', '订单日期', 'order_date', 'order date'],
  shop_id: ['店铺', '店铺名称', 'shop', 'shop_name'],
  salesperson_id: ['业务员', '销售员', 'salesperson', 'sales'],
  customer_id: ['客户', '客户名称', 'customer', 'customer_name'],
  external_order_number: ['订单号', '单号', '平台订单号', 'order_number', 'order no', 'order number'],
  daily_shipping_date: ['发货日期', '出货日期', 'shipping_date', 'shipping date'],
  daily_shipping_number: ['发货单号', '物流单号', '快递单号', 'shipping_number', 'tracking number'],
  daily_shipping_category: ['发货分类', '发货类型', 'shipping_category', 'shipping category'],
  product_id: ['产品名称', '产品', 'sku', 'product', 'product_name'],
  quantity: ['数量', 'qty', 'quantity'],
  unit_price: ['销售单价', '单价', 'sales_unit_price', 'unit price'],
  product_received_amount: ['产品实收金额', '实收金额', 'product_received_amount'],
  logistics_fee_amount: ['运费实收金额', '物流费用', '运费', 'logistics_fee'],
  sales_total_amount: ['销售总金额', '销售总额', 'sales_total_amount', 'total amount'],
  receivable_received_difference_reason: [
    '应收实收差额原因',
    '差额原因',
    'receivable_received_difference_reason',
    'difference reason',
  ],
  daily_payment_category: ['收款分类', '收款类型', 'payment_category', 'payment category'],
  sales_notes: ['备注', '说明', 'remarks', 'notes'],
  currency: ['币种', '货币', 'currency'],
  exchange_rate_to_cny: ['汇率', '折人民币汇率', 'exchange_rate', 'exchange rate'],
}

export interface BusinessDailyImportReference {
  shops: Array<DailyOrderShop & { salespersonIds?: string[] }>
  salespeople: Pick<Profile, 'id' | 'full_name' | 'email' | 'chinese_name'>[]
  products: Pick<Product, 'id' | 'name' | 'sku'>[]
  customers: Pick<Customer, 'id' | 'name'>[]
}

export interface BusinessDailyImportRow extends Record<string, unknown> {
  rowNumber: number
  order_date: string
  shop_id: string
  shop_name: string
  salesperson_id: string
  salesperson_name: string
  customer_id: string
  customer_name: string
  external_order_number: string
  daily_shipping_date: string
  daily_shipping_number: string
  daily_shipping_category: DailyOrderShippingCategory | ''
  product_id: string
  product_name: string
  quantity: string
  unit_price: string
  product_received_amount: string
  logistics_fee_amount: string
  sales_total_amount: string
  receivable_received_difference_reason: string
  daily_payment_category: DailyOrderPaymentCategory | ''
  sales_notes: string
  currency: string
  exchange_rate_to_cny: string
  errors: string[]
}

/** 单次导入的行数上限，与订单明细上限保持一致。 */
export const BUSINESS_DAILY_IMPORT_MAX_ROWS = 500

function normalizedHeader(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s_-]+/g, '')
}

const aliasIndex = Object.fromEntries(
  Object.entries(HEADER_ALIASES).flatMap(([field, aliases]) =>
    aliases.map((alias) => [normalizedHeader(alias), field]),
  ),
) as Record<string, BusinessDailyImportField>

function parseDateValue(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  if (typeof value === 'number' && value > 0) {
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10)
  }
  const text = String(value ?? '').trim()
  if (!text) return ''
  const normalized = text.replace(/[./]/g, '-')
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString().slice(0, 10)
}

function parseMoney(value: unknown): { amount: string; currency: CurrencyCode | '' } {
  const text = String(value ?? '').trim()
  const currency: CurrencyCode | '' = /USD|US\$|美元/i.test(text)
    ? 'USD'
    : /CNY|RMB|人民币|¥|￥/i.test(text)
      ? 'CNY'
      : /EUR|欧元|€/i.test(text)
        ? 'EUR'
        : /GBP|英镑|£/i.test(text)
          ? 'GBP'
          : /JPY|日元/i.test(text)
            ? 'JPY'
            : ''
  return {
    amount: text.replace(/CNY|RMB|USD|US\$|EUR|GBP|JPY|人民币|美元|欧元|英镑|日元|[¥￥,$€£，\s]/gi, ''),
    currency,
  }
}

function shippingValue(value: unknown): DailyOrderShippingCategory | '' {
  const text = normalizedHeader(value)
  if (['stock', '现货'].includes(text)) return 'stock'
  if (['sample', '样品', '样板'].includes(text)) return 'sample'
  if (['custom', '定制'].includes(text)) return 'custom'
  if (['purchase', '外采', '外购', '采购'].includes(text)) return 'purchase'
  return ''
}

function paymentValue(value: unknown): DailyOrderPaymentCategory | '' {
  const text = normalizedHeader(value)
  if (['full', '全款'].includes(text)) return 'full'
  if (['deposit', '定金'].includes(text)) return 'deposit'
  if (['balance', '尾款', '余款'].includes(text)) return 'balance'
  return ''
}

function currencyValue(value: unknown): CurrencyCode | '' {
  const text = String(value ?? '').trim().toUpperCase()
  const matched = CURRENCIES.find((code) => code === text)
  if (matched) return matched
  return parseMoney(value).currency
}

function roundMoney(value: number) {
  return roundToScale(value, 2)
}

function numberOrNull(value: string) {
  if (!value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 单行校验：只做能在单行判断的规则，跨行一致性在分组时再检查。 */
export function validateBusinessDailyImportRow(
  row: BusinessDailyImportRow,
  refs: BusinessDailyImportReference,
) {
  const errors: string[] = []
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.order_date)) errors.push('下单日期格式应为 YYYY-MM-DD')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.daily_shipping_date)) errors.push('发货日期格式应为 YYYY-MM-DD')

  const shop = refs.shops.find((item) => item.id === row.shop_id && item.is_active)
  if (!row.shop_id || !shop) errors.push('店铺不存在或已停用')
  if (!row.salesperson_id || !refs.salespeople.some((person) => person.id === row.salesperson_id)) {
    errors.push('业务员不存在或未审核')
  } else if (shop?.salespersonIds && !shop.salespersonIds.includes(row.salesperson_id)) {
    errors.push('所选业务员未分配到该店铺')
  }
  if (!row.customer_id || !refs.customers.some((customer) => customer.id === row.customer_id)) {
    errors.push('客户不存在或当前账号无权使用')
  }
  if (!row.product_id || !refs.products.some((product) => product.id === row.product_id)) {
    errors.push('产品不存在或已停用')
  }
  if (!row.external_order_number.trim()) errors.push('请填写订单号')
  if (!row.daily_shipping_category) errors.push('发货分类只能是现货/样品/定制/外采')
  if (!row.daily_payment_category) errors.push('收款分类只能是全款/定金/尾款')

  const quantity = numberOrNull(row.quantity)
  if (quantity === null || quantity <= 0) errors.push('数量必须大于 0')
  const unitPrice = numberOrNull(row.unit_price)
  if (unitPrice === null || unitPrice < 0) errors.push('销售单价不能为负')
  const productReceived = numberOrNull(row.product_received_amount)
  if (row.product_received_amount.trim() && (productReceived === null || productReceived < 0)) {
    errors.push('产品实收金额不能为负')
  }
  const logisticsFee = numberOrNull(row.logistics_fee_amount)
  if (row.logistics_fee_amount.trim() && (logisticsFee === null || logisticsFee < 0)) {
    errors.push('运费实收金额不能为负')
  }
  const salesTotal = numberOrNull(row.sales_total_amount)
  if (row.sales_total_amount.trim() && (salesTotal === null || salesTotal < 0)) {
    errors.push('销售总金额不能为负')
  }
  if (row.receivable_received_difference_reason.trim().length > 1000) {
    errors.push('应收实收差额原因不能超过 1000 字')
  }

  const currency = currencyValue(row.currency)
  if (!currency) errors.push(`币种只能是 ${CURRENCIES.join(' / ')}`)
  const rate = numberOrNull(row.exchange_rate_to_cny)
  if (currency === 'CNY') {
    if (rate !== null && rate !== 1) errors.push('人民币订单汇率必须为 1')
  } else if (currency && (rate === null || rate <= 0)) {
    errors.push('外币订单必须填写大于 0 的汇率')
  }

  return [...new Set(errors)]
}

export function mapBusinessDailyImportRows(
  matrix: unknown[][],
  refs: BusinessDailyImportReference,
): BusinessDailyImportRow[] {
  if (matrix.length < 2) return []
  const fields = matrix[0].map((heading) => aliasIndex[normalizedHeader(heading)] ?? null)

  return matrix
    .slice(1, BUSINESS_DAILY_IMPORT_MAX_ROWS + 1)
    .filter((row) => row.some((cell) => String(cell ?? '').trim()))
    .map((row, index) => {
      const raw: Partial<Record<BusinessDailyImportField, unknown>> = {}
      fields.forEach((field, col) => {
        if (field && raw[field] === undefined) raw[field] = row[col]
      })

      const lowered = (value: unknown) => String(value ?? '').trim().toLocaleLowerCase()
      const shopText = lowered(raw.shop_id)
      const salesText = lowered(raw.salesperson_id)
      const customerText = lowered(raw.customer_id)
      const productText = lowered(raw.product_id)

      const shop = refs.shops.find((item) => item.name.trim().toLocaleLowerCase() === shopText)
      const assignedIds = new Set(shop?.salespersonIds ?? refs.salespeople.map((person) => person.id))
      const salespersonMatches = refs.salespeople.filter(
        (item) =>
          assignedIds.has(item.id) &&
          [item.chinese_name, item.full_name, item.email].some(
            (name) => name?.trim().toLocaleLowerCase() === salesText,
          ),
      )
      const salesperson = salespersonMatches.length === 1 ? salespersonMatches[0] : undefined
      const customerMatches = refs.customers.filter(
        (item) => item.name.trim().toLocaleLowerCase() === customerText,
      )
      const customer = customerMatches.length === 1 ? customerMatches[0] : undefined
      const product = refs.products.find(
        (item) =>
          item.name.trim().toLocaleLowerCase() === productText ||
          item.sku.trim().toLocaleLowerCase() === productText,
      )

      const unit = parseMoney(raw.unit_price)
      const received = parseMoney(raw.product_received_amount)
      const logistics = parseMoney(raw.logistics_fee_amount)
      const total = parseMoney(raw.sales_total_amount)
      const currency =
        currencyValue(raw.currency) ||
        unit.currency ||
        total.currency ||
        (shop?.default_currency as CurrencyCode | undefined) ||
        ''
      const rateText = String(raw.exchange_rate_to_cny ?? '').replace(/[,\s]/g, '')

      const result: BusinessDailyImportRow = {
        rowNumber: index + 2,
        order_date: parseDateValue(raw.order_date),
        shop_id: shop?.id ?? '',
        shop_name: String(raw.shop_id ?? ''),
        salesperson_id: salesperson?.id ?? '',
        salesperson_name: String(raw.salesperson_id ?? ''),
        customer_id: customer?.id ?? '',
        customer_name: String(raw.customer_id ?? ''),
        external_order_number: String(raw.external_order_number ?? '').trim(),
        daily_shipping_date: parseDateValue(raw.daily_shipping_date || raw.order_date),
        daily_shipping_number: String(raw.daily_shipping_number ?? '').trim(),
        daily_shipping_category: String(raw.daily_shipping_category ?? '').trim()
          ? shippingValue(raw.daily_shipping_category)
          : 'stock',
        product_id: product?.id ?? '',
        product_name: String(raw.product_id ?? ''),
        quantity: String(raw.quantity ?? '').replace(/,/g, '').trim(),
        unit_price: unit.amount.trim(),
        product_received_amount: received.amount.trim(),
        logistics_fee_amount: logistics.amount.trim(),
        sales_total_amount: total.amount.trim(),
        receivable_received_difference_reason: String(
          raw.receivable_received_difference_reason ?? '',
        ).trim(),
        daily_payment_category: String(raw.daily_payment_category ?? '').trim()
          ? paymentValue(raw.daily_payment_category)
          : 'full',
        sales_notes: String(raw.sales_notes ?? '').trim(),
        currency,
        exchange_rate_to_cny: rateText || (currency === 'CNY' ? '1' : ''),
        errors: [],
      }

      if (!shop) result.errors.push('店铺未精确匹配')
      if (!salesperson) result.errors.push('业务员未精确匹配或匹配不唯一')
      if (!customer) result.errors.push('客户未精确匹配或匹配不唯一')
      if (!product) result.errors.push('产品未精确匹配')
      result.errors = [...new Set([...result.errors, ...validateBusinessDailyImportRow(result, refs)])]
      return result
    })
}

export interface BusinessDailyImportGroup {
  key: string
  orderNumber: string
  rowNumbers: number[]
  input: BusinessOrderInput
}

export interface BusinessDailyImportGroupResult {
  groups: BusinessDailyImportGroup[]
  errors: string[]
}

/** 同一订单号 + 店铺 + 业务员 + 客户的多行合并为一张订单，其余表头字段必须一致。 */
export function groupBusinessDailyImportRows(
  rows: BusinessDailyImportRow[],
): BusinessDailyImportGroupResult {
  const buckets = new Map<string, BusinessDailyImportRow[]>()
  rows.forEach((row) => {
    const key = [
      row.external_order_number.trim().toLocaleLowerCase(),
      row.shop_id,
      row.salesperson_id,
      row.customer_id,
    ].join('|')
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else buckets.set(key, [row])
  })

  const groups: BusinessDailyImportGroup[] = []
  const errors: string[] = []

  buckets.forEach((bucket, key) => {
    const head = bucket[0]
    const rowNumbers = bucket.map((row) => row.rowNumber)
    const label = `订单号 ${head.external_order_number}（源行 ${rowNumbers.join('、')}）`
    const inconsistent = (
      [
        ['order_date', '下单日期'],
        ['daily_shipping_date', '发货日期'],
        ['daily_shipping_number', '发货单号'],
        ['daily_payment_category', '收款分类'],
        ['receivable_received_difference_reason', '应收实收差额原因'],
        ['sales_notes', '备注'],
        ['currency', '币种'],
        ['exchange_rate_to_cny', '汇率'],
      ] as const
    ).filter(([field]) => bucket.some((row) => row[field] !== head[field]))
    if (inconsistent.length > 0) {
      errors.push(`${label}的${inconsistent.map(([, name]) => name).join('、')}在各行不一致`)
      return
    }

    const items = bucket.map((row) => {
      const quantity = Number(row.quantity)
      const unitPrice = Number(row.unit_price)
      const automaticProductReceived = roundMoney(quantity * unitPrice)
      const productReceived = row.product_received_amount.trim()
        ? roundMoney(Number(row.product_received_amount))
        : automaticProductReceived
      const logisticsFee = row.logistics_fee_amount.trim()
        ? roundMoney(Number(row.logistics_fee_amount))
        : 0
      const automaticSalesTotal = roundMoney(productReceived + logisticsFee)
      const salesTotal = row.sales_total_amount.trim()
        ? roundMoney(Number(row.sales_total_amount))
        : automaticSalesTotal
      return {
        source_type: 'catalog' as const,
        product_id: row.product_id,
        quantity,
        unit_price: unitPrice,
        daily_shipping_category: row.daily_shipping_category as DailyOrderShippingCategory,
        product_received_amount: productReceived,
        product_received_overridden: productReceived !== automaticProductReceived,
        logistics_fee_amount: logisticsFee,
        sales_total_amount: salesTotal,
        sales_total_overridden: salesTotal !== automaticSalesTotal,
      }
    })

    const productTotal = roundMoney(items.reduce((sum, item) => sum + item.product_received_amount, 0))
    const shippingTotal = roundMoney(items.reduce((sum, item) => sum + item.logistics_fee_amount, 0))
    const salesTotal = roundMoney(items.reduce((sum, item) => sum + item.sales_total_amount, 0))
    if (Math.round(salesTotal * 100) !== Math.round(productTotal * 100) + Math.round(shippingTotal * 100)) {
      errors.push(`${label}的销售总金额不等于产品实收加运费实收，请修正明细金额`)
      return
    }

    const receivableTotal = roundMoney(
      items.reduce((sum, item) => sum + roundMoney(item.quantity * item.unit_price), 0) +
        shippingTotal,
    )
    const hasReceivableReceivedDifference =
      Math.round(receivableTotal * 100) !== Math.round(salesTotal * 100)
    const differenceReason = head.receivable_received_difference_reason.trim()
    if (hasReceivableReceivedDifference && !differenceReason) {
      errors.push(`${label}的应收与实收存在差额，请填写差额原因`)
      return
    }

    const candidate = {
      customer_id: head.customer_id,
      shop_id: head.shop_id,
      salesperson_id: head.salesperson_id,
      external_order_number: head.external_order_number,
      order_date: head.order_date,
      payment_due_date: '',
      // 明细里出现定制发货分类时按定制订单登记，其余按现货。
      fulfillment_type: items.some((item) => item.daily_shipping_category === 'custom')
        ? ('custom' as const)
        : ('stock' as const),
      currency: head.currency,
      exchange_rate_to_cny: head.currency === 'CNY' ? 1 : Number(head.exchange_rate_to_cny),
      // 生命周期运费与每日运费实收保持同一口径，避免两套金额打架。
      shipping_fee: shippingTotal,
      tracking_number: '',
      sales_notes: head.sales_notes,
      daily_shipping_date: head.daily_shipping_date,
      daily_shipping_number: head.daily_shipping_number,
      daily_payment_category: head.daily_payment_category,
      total_product_received_amount: productTotal,
      total_product_received_overridden: false,
      total_shipping_received_amount: shippingTotal,
      total_shipping_received_overridden: false,
      total_sales_amount: salesTotal,
      total_sales_overridden: false,
      receivable_received_difference_reason: hasReceivableReceivedDifference
        ? differenceReason
        : '',
      items,
    }

    const parsed = businessOrderInputSchema.safeParse(candidate)
    if (!parsed.success) {
      errors.push(`${label}校验失败：${parsed.error.issues[0]?.message ?? '数据不合法'}`)
      return
    }

    groups.push({
      key,
      orderNumber: head.external_order_number,
      rowNumbers,
      input: parsed.data,
    })
  })

  return { groups, errors }
}

export const BUSINESS_DAILY_IMPORT_SHIPPING_OPTIONS = businessOrderDailyShippingCategories
export const BUSINESS_DAILY_IMPORT_PAYMENT_OPTIONS = businessPaymentTypes
export const BUSINESS_DAILY_IMPORT_CURRENCY_OPTIONS = CURRENCIES
