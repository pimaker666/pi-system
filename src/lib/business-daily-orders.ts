import type {
  BusinessOrder,
  BusinessOrderAttachment,
  BusinessOrderItem,
  BusinessOrderReturn,
  BusinessOrderReturnItem,
  BusinessOrderShipment,
  BusinessOrderShipmentItem,
  CurrencyCode,
  DailyOrderShippingCategory,
  Profile,
} from '@/types'
import {
  businessOrderItemDisplayName,
  businessOrderItemDisplaySku,
} from '@/lib/business-order-financials'
import { roundToScale } from '@/lib/utils'

/**
 * 恢复后的每日订单台账行：业务订单（表头）+ 产品明细（每行一个产品）。
 * 数据源只有 business_orders / business_order_items / business_order_attachments，
 * 旧 finance_daily_* 表仍保持 0031 的冻结状态，仅在“历史台账”页只读查询。
 */
/**
 * 收款分摊（含订单转账）的精简投影，只取合并/汇总所需字段。
 * allocation_target: 'item' 落到具体产品行（order_item_id），'shipping' 落到订单运费，
 * 'order' 为 0047 之前的整单历史分摊（不归属到具体产品行）。
 */
export interface BusinessOrderPaymentAllocationLite {
  order_item_id: string | null
  allocation_target: 'order' | 'item' | 'shipping'
  amount: number | string
  voided_at?: string | null
  transfer?: { voided_at?: string | null } | null
}

export interface BusinessDailyLedgerOrder extends BusinessOrder {
  business_order_items: BusinessOrderItem[]
  business_order_attachments?: BusinessOrderAttachment[]
  business_order_shipments?: Array<
    BusinessOrderShipment & { business_order_shipment_items?: BusinessOrderShipmentItem[] }
  >
  business_order_returns?: Array<
    BusinessOrderReturn & { business_order_return_items?: BusinessOrderReturnItem[] }
  >
  business_order_payment_allocations?: BusinessOrderPaymentAllocationLite[]
  outstanding_amount: number
  customer?: { tag_color?: string | null }
}

/**
 * 生效分摊 = 分摊未作废且所属转账未作废。把生效分摊拆成三份：
 * itemById（按产品行 order_item_id 汇总）、shippingTotal（订单运费）、orderTotal（历史整单）。
 * 后续新增收款补齐运费 / 产品实收时，实收显示以「静态列 + 生效分摊」为准，全站口径一致。
 */
export function businessOrderAllocationBreakdown(order: {
  business_order_payment_allocations?: BusinessOrderPaymentAllocationLite[]
}): { itemById: Map<string, number>; shippingTotal: number; orderTotal: number } {
  const itemById = new Map<string, number>()
  let shippingTotal = 0
  let orderTotal = 0
  for (const alloc of order.business_order_payment_allocations ?? []) {
    if (alloc.voided_at) continue
    if (alloc.transfer?.voided_at) continue
    const amount = Number(alloc.amount)
    if (!Number.isFinite(amount) || amount === 0) continue
    if (alloc.allocation_target === 'item' && alloc.order_item_id) {
      itemById.set(alloc.order_item_id, (itemById.get(alloc.order_item_id) ?? 0) + amount)
    } else if (alloc.allocation_target === 'shipping') {
      shippingTotal += amount
    } else {
      orderTotal += amount
    }
  }
  return { itemById, shippingTotal, orderTotal }
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
 * 若订单带有收款分摊，则把生效分摊并入实收（产品实收/运费实收/销售总额），
 * 差额按「应收 - 销售总额」计算，与产品行「静态列 + 分摊」的口径保持一致。
 */
export function businessDailyOrderTotals(
  order: BusinessOrder & {
    business_order_payment_allocations?: BusinessOrderPaymentAllocationLite[]
  },
) {
  const receivable = Number(order.total_amount)
  const declaredSalesTotal =
    order.total_sales_amount === null ? receivable : Number(order.total_sales_amount)
  const declaredProductReceived =
    order.total_product_received_amount === null
      ? Number(order.items_subtotal)
      : Number(order.total_product_received_amount)
  const declaredShippingReceived =
    order.total_shipping_received_amount === null
      ? Number(order.shipping_fee)
      : Number(order.total_shipping_received_amount)

  const { itemById, shippingTotal } = businessOrderAllocationBreakdown(order)
  const itemAllocated = [...itemById.values()].reduce((sum, value) => sum + value, 0)

  const productReceived = roundToScale(declaredProductReceived + itemAllocated, 2)
  const shippingReceived = roundToScale(declaredShippingReceived + shippingTotal, 2)
  const salesTotal = roundToScale(declaredSalesTotal + itemAllocated + shippingTotal, 2)

  return {
    receivable,
    productReceived,
    shippingReceived,
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

function itemProductKey(item: BusinessOrderItem): string {
  if (item.product_id) return `p:${item.product_id}`
  if (item.custom_product_id) return `c:${item.custom_product_id}`
  return `s:${item.sku_snapshot}|${item.name_snapshot}`
}

export function sortedBusinessDailyItems(order: BusinessDailyLedgerOrder) {
  const items = order.business_order_items ?? []
  const groups = new Map<string, BusinessOrderItem[]>()
  for (const item of items) {
    const key = itemProductKey(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  for (const group of groups.values()) {
    group.sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
      return a.created_at.localeCompare(b.created_at)
    })
  }
  const sortedGroups = [...groups.values()].sort(
    (a, b) => a[0].sort_order - b[0].sort_order,
  )
  return sortedGroups.flat()
}

/** 台账/成本/导出里合并后的产品行：同一订单内同一产品且单价相同的多行聚合。 */
export interface MergedBusinessDailyItem {
  id: string
  item_ids: string[]
  product_id: string | null
  custom_product_id: string | null
  sku_snapshot: string
  name_snapshot: string
  image_url_snapshot: string | null
  display_name?: string | null
  display_sku?: string | null
  daily_shipping_category: DailyOrderShippingCategory | null
  unit_price: number
  quantity: number
  product_received_amount: number
  logistics_fee_amount: number | null
  sales_total_amount: number
  net_shipped: number
}

export function isMergedBusinessDailyItemFullyPaid(item: MergedBusinessDailyItem) {
  const productReceivable = roundToScale(item.quantity * item.unit_price, 2)
  return item.product_received_amount >= productReceivable
}

export function isMergedBusinessDailyItemPaidAndShipped(item: MergedBusinessDailyItem) {
  return isMergedBusinessDailyItemFullyPaid(item) && item.net_shipped >= item.quantity
}

function mergedBusinessDailyItemKey(item: BusinessOrderItem): string {
  return `${itemProductKey(item)}|${item.daily_shipping_category ?? ''}|${Number(item.unit_price)}`
}

export function mergeBusinessDailyItems(
  order: BusinessDailyLedgerOrder,
): MergedBusinessDailyItem[] {
  const sorted = sortedBusinessDailyItems(order)
  const groups = new Map<string, BusinessOrderItem[]>()
  for (const item of sorted) {
    const key = mergedBusinessDailyItemKey(item)
    const list = groups.get(key)
    if (list) list.push(item)
    else groups.set(key, [item])
  }

  const { itemById, shippingTotal } = businessOrderAllocationBreakdown(order)

  return [...groups.values()].map((group, index) => {
    const first = group[0]
    const quantity = roundToScale(
      group.reduce((sum, item) => sum + Number(item.quantity), 0),
      4,
    )
    const groupItemAllocated = group.reduce(
      (sum, item) => sum + (itemById.get(item.id) ?? 0),
      0,
    )
    // 运费分摊按用户约定「全部计入某一行」：整单运费分摊落到首行（index === 0）。
    const groupShippingAllocated = index === 0 ? shippingTotal : 0
    const productReceived = roundToScale(
      group.reduce(
        (sum, item) =>
          sum +
          (item.product_received_amount === null
            ? Number(item.line_amount)
            : Number(item.product_received_amount)),
        0,
      ) + groupItemAllocated,
      2,
    )
    const logisticsFees = group.map((item) =>
      item.logistics_fee_amount === null ? null : Number(item.logistics_fee_amount),
    )
    const declaredLogisticsFee = logisticsFees.some((value) => value !== null)
      ? roundToScale(
          logisticsFees.reduce<number>((sum, value) => sum + (value ?? 0), 0),
          2,
        )
      : null
    const logisticsFee =
      groupShippingAllocated !== 0
        ? roundToScale((declaredLogisticsFee ?? 0) + groupShippingAllocated, 2)
        : declaredLogisticsFee
    const salesTotal = roundToScale(
      group.reduce(
        (sum, item) =>
          sum +
          (item.sales_total_amount === null
            ? Number(item.line_amount)
            : Number(item.sales_total_amount)),
        0,
      ) + groupItemAllocated + groupShippingAllocated,
      2,
    )
    const netShipped = group.reduce(
      (sum, item) => sum + getBusinessOrderItemNetShipped(order, item),
      0,
    )

    return {
      id: `${order.id}-${index}`,
      item_ids: group.map((item) => item.id),
      product_id: first.product_id,
      custom_product_id: first.custom_product_id,
      sku_snapshot: first.sku_snapshot,
      name_snapshot: first.name_snapshot,
      image_url_snapshot: first.image_url_snapshot,
      display_name: (first as { display_name?: string | null }).display_name,
      display_sku: (first as { display_sku?: string | null }).display_sku,
      daily_shipping_category: first.daily_shipping_category,
      unit_price: Number(first.unit_price),
      quantity,
      product_received_amount: productReceived,
      logistics_fee_amount: logisticsFee,
      sales_total_amount: salesTotal,
      net_shipped: netShipped,
    }
  })
}

export function formatMergedBusinessDailyShippingProgress(
  merged: MergedBusinessDailyItem,
): string {
  const formatQuantity = (value: number) =>
    value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
  return `已发 ${formatQuantity(merged.net_shipped)} / ${formatQuantity(merged.quantity)}`
}

export function getBusinessOrderItemNetShipped(
  order: Pick<BusinessDailyLedgerOrder, 'business_order_shipments' | 'business_order_returns'>,
  item: BusinessOrderItem,
) {
  const activeShipmentIds = new Set(
    (order.business_order_shipments ?? [])
      .filter((shipment) => !shipment.voided_at)
      .map((shipment) => shipment.id),
  )
  const shipped = (order.business_order_shipments ?? []).reduce((total, shipment) => {
    if (!activeShipmentIds.has(shipment.id)) return total
    return total + (shipment.business_order_shipment_items ?? [])
      .filter((shipmentItem) => shipmentItem.order_item_id === item.id)
      .reduce((sum, shipmentItem) => sum + Number(shipmentItem.quantity), 0)
  }, 0)
  const activeReturnIds = new Set(
    (order.business_order_returns ?? [])
      .filter((returnRecord) => !returnRecord.voided_at)
      .map((returnRecord) => returnRecord.id),
  )
  const returned = (order.business_order_returns ?? []).reduce((total, returnRecord) => {
    if (!activeReturnIds.has(returnRecord.id)) return total
    return total + (returnRecord.business_order_return_items ?? [])
      .filter((returnItem) => returnItem.order_item_id === item.id)
      .reduce((sum, returnItem) => sum + Number(returnItem.quantity), 0)
  }, 0)
  return Math.max(0, shipped - returned)
}

export function getBusinessOrderItemRemainingQuantity(
  order: BusinessDailyLedgerOrder,
  item: BusinessOrderItem,
) {
  return Math.max(0, Number(item.quantity) - getBusinessOrderItemNetShipped(order, item))
}

export function formatBusinessDailyShippingProgress(
  order: BusinessDailyLedgerOrder,
  item: BusinessOrderItem,
) {
  const netShipped = getBusinessOrderItemNetShipped(order, item)
  const formatQuantity = (value: number) =>
    value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
  return `已发 ${formatQuantity(netShipped)} / ${formatQuantity(Number(item.quantity))}`
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
  shippingProgress: string
  unitPrice: string
  productReceived: string
  logisticsFee: string
  orderTotal: string
  outstandingAmount: string
  paymentCategory: string
  remarks: string
  /** 订单截图只挂在该订单的第一行，避免同一订单重复导出图片。 */
  attachments: BusinessOrderAttachment[]
  /** 产品行成本结算状态：是 / 否。 */
  settlementStatus: string
  /** 产品行提成结清状态：已结清 / 未结清。 */
  commissionClearanceStatus: string
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
    isItemSettled?: (item: MergedBusinessDailyItem) => boolean
    isCommissionCleared?: (item: MergedBusinessDailyItem) => boolean
  },
): BusinessDailyExportRow[] {
  return orders.flatMap((order, orderIndex) => {
    const items = mergeBusinessDailyItems(order)
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
      shippingNumber: order.daily_shipping_number || order.payment_account || '',
      orderTotal: format.money(Number(order.total_amount), order.currency),
      outstandingAmount: format.money(order.outstanding_amount, order.currency),
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
          shippingProgress: '',
          unitPrice: '',
          productReceived: '',
          logisticsFee: '',
          settlementStatus: '',
          commissionClearanceStatus: '',
          attachments,
        },
      ]
    }

    return items.map((item, itemIndex) => {
      return {
        ...header,
        sequence:
          items.length > 1 ? `${orderIndex + 1}-${itemIndex + 1}` : String(orderIndex + 1),
        shippingCategory: format.shipping(item.daily_shipping_category),
        productName: businessOrderItemDisplayName(item),
        productSku: businessOrderItemDisplaySku(item),
        quantity: String(item.quantity),
        shippingProgress: formatMergedBusinessDailyShippingProgress(item),
        unitPrice: format.money(item.unit_price, order.currency),
        productReceived: format.money(item.product_received_amount, order.currency),
        logisticsFee:
          item.logistics_fee_amount === null
            ? ''
            : format.money(item.logistics_fee_amount, order.currency),
        settlementStatus: format.isItemSettled?.(item) ? '是' : '否',
        commissionClearanceStatus: format.isCommissionCleared?.(item) ? '已结清' : '未结清',
        attachments: itemIndex === 0 ? attachments : [],
      }
    })
  })
}
