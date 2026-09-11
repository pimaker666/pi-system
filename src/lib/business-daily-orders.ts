import type {
  BusinessOrder,
  BusinessOrderAttachment,
  BusinessOrderItem,
  CurrencyCode,
  Profile,
} from '@/types'

/**
 * 恢复后的每日订单台账行：业务订单（表头）+ 产品明细（每行一个产品）。
 * 数据源只有 business_orders / business_order_items / business_order_attachments，
 * 旧 finance_daily_* 表仍保持 0031 的冻结状态，仅在“历史台账”页只读查询。
 */
export interface BusinessDailyLedgerOrder extends BusinessOrder {
  business_order_items: BusinessOrderItem[]
  business_order_attachments?: BusinessOrderAttachment[]
}

export type BusinessDailyTotalField =
  | 'receivable'
  | 'productReceived'
  | 'shippingReceived'
  | 'salesTotal'
  | 'difference'

/** 台账使用的币种（其余币种只在出现时额外展示，不并入 CNY/USD）。 */
export const BUSINESS_DAILY_PRIMARY_CURRENCIES: CurrencyCode[] = ['CNY', 'USD']

/**
 * 明细行的四个金额。0034 之后的每日订单会显式存产品实收 / 运费实收 / 销售总额；
 * 0034 之前创建的业务订单这些列为 null，此时用行金额（数量 × 单价）兜底，
 * 运费实收留空（历史订单的运费只记在表头 shipping_fee，没有按行拆分）。
 */
export function businessDailyItemAmounts(item: BusinessOrderItem) {
  const lineAmount = Number(item.line_amount)
  return {
    unitPrice: Number(item.unit_price),
    productReceived:
      item.product_received_amount === null ? lineAmount : Number(item.product_received_amount),
    logisticsFee: item.logistics_fee_amount === null ? null : Number(item.logistics_fee_amount),
    salesTotal: item.sales_total_amount === null ? lineAmount : Number(item.sales_total_amount),
  }
}

/**
 * 表头三项金额。每日订单直接取 0034 新增的三个总额列；
 * 历史业务订单回落到 items_subtotal / shipping_fee / total_amount，保证台账汇总不丢金额。
 */
export function businessDailyOrderTotals(order: BusinessOrder) {
  const receivable = Number(order.total_amount)
  const salesTotal =
    order.total_sales_amount === null ? receivable : Number(order.total_sales_amount)
  return {
    receivable,
    productReceived:
      order.total_product_received_amount === null
        ? Number(order.items_subtotal)
        : Number(order.total_product_received_amount),
    shippingReceived:
      order.total_shipping_received_amount === null
        ? Number(order.shipping_fee)
        : Number(order.total_shipping_received_amount),
    salesTotal,
    difference: Math.round((receivable - salesTotal) * 100) / 100,
  }
}

/** 按币种汇总表头金额；不做汇率折算，避免把不同币种混成一个数字。 */
export function sumBusinessDailyByCurrency(
  orders: BusinessOrder[],
  field: BusinessDailyTotalField,
): Partial<Record<CurrencyCode, number>> {
  return orders.reduce<Partial<Record<CurrencyCode, number>>>((totals, order) => {
    const amount = businessDailyOrderTotals(order)[field]
    totals[order.currency] = (totals[order.currency] ?? 0) + amount
    return totals
  }, {})
}

/** 台账里展示的币种顺序：先 CNY/USD（即使为 0），再列出其他出现过的币种。 */
export function businessDailyCurrencyOrder(
  totals: Partial<Record<CurrencyCode, number>>,
): CurrencyCode[] {
  const extras = (Object.keys(totals) as CurrencyCode[]).filter(
    (currency) => !BUSINESS_DAILY_PRIMARY_CURRENCIES.includes(currency),
  )
  return [...BUSINESS_DAILY_PRIMARY_CURRENCIES, ...extras]
}

export function activeBusinessOrderAttachments(order: BusinessDailyLedgerOrder) {
  return (order.business_order_attachments ?? []).filter(
    (attachment) => attachment.status === 'active',
  )
}

export function sortedBusinessDailyItems(order: BusinessDailyLedgerOrder) {
  return [...(order.business_order_items ?? [])].sort((left, right) => {
    if (left.sort_order !== right.sort_order) return left.sort_order - right.sort_order
    return left.created_at.localeCompare(right.created_at)
  })
}

/** 订单在台账中可否直接编辑，与 /finance/daily-orders/[id]/edit 的服务端门禁保持一致。 */
export function canEditBusinessDailyOrder(
  order: BusinessOrder,
  actor: Pick<Profile, 'id' | 'role'>,
) {
  if (order.closed_at) return false
  if (actor.role === 'admin' || actor.role === 'finance') {
    return ['draft', 'rejected', 'approved'].includes(order.status)
  }
  if (!['draft', 'rejected'].includes(order.status)) return false
  if (actor.role !== 'sales' && actor.role !== 'supervisor') return false
  return order.salesperson_id === actor.id
}

/** 导出行：一行一个产品，表头字段在每行重复，保证 XLSX / PDF 都能独立成行阅读。 */
export interface BusinessDailyExportRow {
  orderId: string
  sequence: string
  orderDate: string
  shop: string
  salesperson: string
  orderNumber: string
  shippingDate: string
  shippingNumber: string
  shippingCategory: string
  productName: string
  productSku: string
  quantity: string
  unitPrice: string
  productReceived: string
  logisticsFee: string
  salesTotal: string
  paymentCategory: string
  remarks: string
  /** 订单截图只挂在该订单的第一行，避免同一订单重复导出图片。 */
  attachments: BusinessOrderAttachment[]
}

/** 单次导出的截图数量与体积上限，沿用旧台账的阈值。 */
export const BUSINESS_DAILY_EXPORT_MAX_IMAGES = 100
export const BUSINESS_DAILY_EXPORT_MAX_IMAGE_BYTES = 50 * 1024 * 1024
/** 每张订单最多导出的截图数量，与建单时的 10 张上限一致。 */
export const BUSINESS_DAILY_EXPORT_MAX_IMAGES_PER_ORDER = 10

export function businessDailyExportLimitError(orders: BusinessDailyLedgerOrder[]) {
  const attachments = orders.flatMap((order) =>
    activeBusinessOrderAttachments(order).slice(0, BUSINESS_DAILY_EXPORT_MAX_IMAGES_PER_ORDER),
  )
  const totalBytes = attachments.reduce((sum, attachment) => sum + Number(attachment.size_bytes), 0)
  if (attachments.length > BUSINESS_DAILY_EXPORT_MAX_IMAGES) {
    return `筛选结果包含 ${attachments.length} 张截图，单次最多导出 ${BUSINESS_DAILY_EXPORT_MAX_IMAGES} 张，请缩小筛选范围`
  }
  if (totalBytes > BUSINESS_DAILY_EXPORT_MAX_IMAGE_BYTES) {
    return '筛选结果的截图总大小超过 50MB，请缩小筛选范围'
  }
  return null
}

export function buildBusinessDailyExportRows(
  orders: BusinessDailyLedgerOrder[],
  format: {
    money: (amount: number, currency: CurrencyCode) => string
    shipping: (value: BusinessOrderItem['daily_shipping_category']) => string
    payment: (value: BusinessOrder['daily_payment_category']) => string
    salesperson: (order: BusinessDailyLedgerOrder) => string
  },
): BusinessDailyExportRow[] {
  return orders.flatMap((order, orderIndex) => {
    const items = sortedBusinessDailyItems(order)
    const attachments = activeBusinessOrderAttachments(order).slice(
      0,
      BUSINESS_DAILY_EXPORT_MAX_IMAGES_PER_ORDER,
    )
    const header = {
      orderId: order.id,
      orderDate: order.order_date,
      shop: order.shop_name_snapshot ?? '',
      salesperson: format.salesperson(order),
      orderNumber: order.external_order_number || order.order_number,
      shippingDate: order.daily_shipping_date ?? '',
      shippingNumber: order.daily_shipping_number || order.tracking_number || '',
      paymentCategory: format.payment(order.daily_payment_category),
      remarks: order.sales_notes ?? '',
    }

    if (items.length === 0) {
      return [
        {
          ...header,
          sequence: String(orderIndex + 1),
          shippingCategory: '',
          productName: '',
          productSku: '',
          quantity: '',
          unitPrice: '',
          productReceived: '',
          logisticsFee: '',
          salesTotal: '',
          attachments,
        },
      ]
    }

    return items.map((item, itemIndex) => {
      const amounts = businessDailyItemAmounts(item)
      return {
        ...header,
        sequence:
          items.length > 1 ? `${orderIndex + 1}-${itemIndex + 1}` : String(orderIndex + 1),
        shippingCategory: format.shipping(item.daily_shipping_category),
        productName: item.name_snapshot,
        productSku: item.sku_snapshot,
        quantity: String(Number(item.quantity)),
        unitPrice: format.money(amounts.unitPrice, order.currency),
        productReceived: format.money(amounts.productReceived, order.currency),
        logisticsFee:
          amounts.logisticsFee === null ? '' : format.money(amounts.logisticsFee, order.currency),
        salesTotal: format.money(amounts.salesTotal, order.currency),
        attachments: itemIndex === 0 ? attachments : [],
      }
    })
  })
}
