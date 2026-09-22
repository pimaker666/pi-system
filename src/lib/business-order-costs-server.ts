import type { SupabaseClient } from '@supabase/supabase-js'
import type { BusinessOrderProductCost, CurrencyCode } from '@/types'
import type { BusinessOrderCostFilters } from '@/schemas/business-order-cost'
import { displayProfileName } from '@/lib/utils'
import { COST_PAGE_SIZE } from '@/lib/business-order-cost'
import {
  activeBusinessOrderAttachments,
  businessDailyOrderTotals,
  formatMergedBusinessDailyShippingProgress,
  isMergedBusinessDailyItemPaidAndShipped,
  mergeBusinessDailyItems,
  type BusinessDailyLedgerOrder,
  type MergedBusinessDailyItem,
} from '@/lib/business-daily-orders'
import { BUSINESS_DAILY_EXPORT_LIMIT, BUSINESS_DAILY_LEDGER_LIMIT } from '@/lib/business-daily-orders-server'

export { BUSINESS_DAILY_EXPORT_LIMIT, BUSINESS_DAILY_LEDGER_LIMIT }

interface ProductFinancialRow {
  product_id: string
  financial_number: string | null
  product_name: string | null
  cost: number | null
}

interface CostOverrideRow {
  business_order_item_id: string
  cost: number
}

const LEDGER_TAIL = `
  salesperson:profiles!salesperson_id(id, chinese_name, full_name, email),
  business_order_attachments(*),
  business_order_shipments(*, business_order_shipment_items(*)),
  business_order_returns(*, business_order_return_items(*)),
  business_order_payment_allocations(order_item_id, allocation_target, amount, voided_at, transfer:business_customer_transfers(voided_at))
`

function normalizeKeyword(raw: string) {
  return raw.replace(/[,()%*]/g, ' ').trim()
}

function monthToDateRange(month: string): { dateFrom: string; dateTo: string } {
  const [year, monthNum] = month.split('-').map(Number)
  const dateFrom = `${month}`
  const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate()
  const dateTo = `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  return { dateFrom, dateTo }
}

function buildBaseQuery(
  supabase: SupabaseClient,
  filters: BusinessOrderCostFilters,
  offset: number,
  limit: number,
  productSearch: boolean,
) {
  const keyword = normalizeKeyword(filters.q)
  const needInner = productSearch
  const itemsEmbed = needInner ? 'business_order_items!inner(*)' : 'business_order_items(*)'

  let query = supabase
    .from('business_orders')
    .select(`*, ${itemsEmbed}, customer:customers!customer_id(tag_color), ${LEDGER_TAIL}`)
    .is('voided_at', null)
    .in('fulfillment_status', ['partially_shipped', 'fully_shipped'])
    .eq('business_order_attachments.status', 'active')
    .order('order_date', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .order('sort_order', { referencedTable: 'business_order_items', ascending: true })
    .range(offset, offset + limit - 1)

  let dateFrom = filters.dateFrom
  let dateTo = filters.dateTo
  if (filters.month) {
    const range = monthToDateRange(filters.month)
    dateFrom = dateFrom && dateFrom > range.dateFrom ? dateFrom : range.dateFrom
    dateTo = dateTo && dateTo < range.dateTo ? dateTo : range.dateTo
  }

  if (dateFrom) query = query.gte('order_date', dateFrom)
  if (dateTo) query = query.lte('order_date', dateTo)
  if (filters.shops.length > 0) query = query.in('shop_id', filters.shops)
  if (filters.salespeople.length > 0) query = query.in('salesperson_id', filters.salespeople)
  if (filters.shopGroups.length > 0) query = query.in('shop_group_id', filters.shopGroups)

  if (keyword) {
    if (productSearch) {
      query = query.or(`name_snapshot.ilike.%${keyword}%,sku_snapshot.ilike.%${keyword}%`, {
        referencedTable: 'business_order_items',
      })
    } else {
      query = query.or(
        [
          `order_number.ilike.%${keyword}%`,
          `external_order_number.ilike.%${keyword}%`,
          `daily_shipping_number.ilike.%${keyword}%`,
          `payment_account.ilike.%${keyword}%`,
          `tracking_number.ilike.%${keyword}%`,
        ].join(','),
      )
    }
  }

  return query
}

function compareOrders(left: BusinessDailyLedgerOrder, right: BusinessDailyLedgerOrder) {
  if (left.order_date !== right.order_date) return left.order_date < right.order_date ? 1 : -1
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1
  return left.id < right.id ? 1 : -1
}

async function fetchMatchingOrders(
  supabase: SupabaseClient,
  filters: BusinessOrderCostFilters,
  offset: number,
  limit: number,
): Promise<BusinessDailyLedgerOrder[]> {
  const keyword = normalizeKeyword(filters.q)

  if (!keyword) {
    const { data, error } = await buildBaseQuery(supabase, filters, offset, limit, false)
    if (error) throw new Error(`订单成本订单读取失败：${error.message}`)
    return (data ?? []) as unknown as BusinessDailyLedgerOrder[]
  }

  const [headResult, itemResult] = await Promise.all([
    buildBaseQuery(supabase, filters, offset, limit, false),
    buildBaseQuery(supabase, filters, offset, limit, true),
  ])
  const error = headResult.error || itemResult.error
  if (error) throw new Error(`订单成本订单读取失败：${error.message}`)

  const merged = new Map<string, BusinessDailyLedgerOrder>()
  for (const order of (headResult.data ?? []) as unknown as BusinessDailyLedgerOrder[]) {
    merged.set(order.id, order)
  }
  for (const order of (itemResult.data ?? []) as unknown as BusinessDailyLedgerOrder[]) {
    if (merged.size >= limit) break
    if (!merged.has(order.id)) merged.set(order.id, order)
  }

  return [...merged.values()].sort(compareOrders).slice(0, limit)
}

async function fetchAllProductFinancials(supabase: SupabaseClient) {
  const rows: ProductFinancialRow[] = []
  const PAGE_SIZE = 1000
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('product_financials')
      .select('product_id, financial_number, product_name, cost')
      .order('product_id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`产品财务资料读取失败：${error.message}`)
    const page = (data ?? []) as ProductFinancialRow[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

async function fetchAllCostOverrides(supabase: SupabaseClient) {
  const rows: CostOverrideRow[] = []
  const PAGE_SIZE = 1000
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('finance_business_order_item_cost_overrides')
      .select('business_order_item_id, cost')
      .order('business_order_item_id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`订单行成本覆盖读取失败：${error.message}`)
    const page = (data ?? []) as CostOverrideRow[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

async function fetchAllSettledItemIds(supabase: SupabaseClient) {
  const ids = new Set<string>()
  const PAGE_SIZE = 1000
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('finance_business_order_item_settlements')
      .select('business_order_item_id')
      .order('business_order_item_id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`订单结算记录读取失败：${error.message}`)
    const page = (data ?? []) as Array<{ business_order_item_id: string }>
    for (const row of page) ids.add(row.business_order_item_id)
    if (page.length < PAGE_SIZE) return ids
  }
}

/** 合并行是否已全部结算（其所有明细行都进入了结算表）。 */
function isMergedRowSettled(item: MergedBusinessDailyItem, settledIds: Set<string>) {
  return item.item_ids.length > 0 && item.item_ids.every((id) => settledIds.has(id))
}

/** 成本页逐合并行判断实收与发货，不受同单其他产品状态影响。 */
function eligibleCostRows(
  order: BusinessDailyLedgerOrder,
  settledIds: Set<string>,
): MergedBusinessDailyItem[] {
  return mergeBusinessDailyItems(order).filter(
    (item) => isMergedBusinessDailyItemPaidAndShipped(item) && !isMergedRowSettled(item, settledIds),
  )
}

function getCustomerName(customerSnapshot: unknown): string | null {
  if (!customerSnapshot || typeof customerSnapshot !== 'object') return null
  const snapshot = customerSnapshot as { name?: string | null; company?: string | null }
  return snapshot.company || snapshot.name || null
}

function getCustomerTagColor(order: BusinessDailyLedgerOrder): string | null {
  const liveColor = order.customer?.tag_color
  if (liveColor) return liveColor
  if (!order.customer_snapshot || typeof order.customer_snapshot !== 'object') return null
  return (order.customer_snapshot as { tag_color?: string | null }).tag_color ?? null
}

export async function fetchBusinessOrderProductCosts(
  supabase: SupabaseClient,
  filters: BusinessOrderCostFilters,
  page = 1,
  pageSize = COST_PAGE_SIZE,
): Promise<{ rows: BusinessOrderProductCost[]; totalCount: number }> {
  const effectiveLimit = Math.min(pageSize, BUSINESS_DAILY_EXPORT_LIMIT)
  const [allOrders, financialRows, overrideRows, settledIds] = await Promise.all([
    fetchMatchingOrders(supabase, filters, 0, 1000),
    fetchAllProductFinancials(supabase),
    fetchAllCostOverrides(supabase),
    fetchAllSettledItemIds(supabase),
  ])

  const { data: outstandingData, error: outstandingError } = await supabase.rpc(
    'get_business_orders_outstanding_amount',
    { p_order_ids: allOrders.map((order) => order.id) },
  )
  if (outstandingError) throw new Error(`订单成本未收尾款读取失败：${outstandingError.message}`)
  const outstandingByOrder = new Map(
    ((outstandingData ?? []) as Array<{ order_id: string; outstanding_amount: number | string }>).map((row) => [
      row.order_id,
      Number(row.outstanding_amount),
    ]),
  )

  const eligibleOrders = allOrders
    .map((order) => ({ order, rows: eligibleCostRows(order, settledIds) }))
    .filter((entry) => entry.rows.length > 0)

  const totalCount = eligibleOrders.length
  const offset = (page - 1) * effectiveLimit
  const pagedOrders = eligibleOrders.slice(offset, offset + effectiveLimit)

  const financials = new Map(financialRows.map((row) => [row.product_id, row]))
  const overrides = new Map(overrideRows.map((row) => [row.business_order_item_id, Number(row.cost)]))

  function resolveMergedCost(
    item: MergedBusinessDailyItem | null,
  ): { cost: number | null; overridden: boolean; catalogCost: number | null } {
    if (!item) return { cost: null, overridden: false, catalogCost: null }
    const isCustom = item.daily_shipping_category === 'custom'
    const financial = !isCustom && item.product_id ? financials.get(item.product_id) : undefined
    const catalogCost = financial?.cost == null ? null : Number(financial.cost)
    const overrideCosts = item.item_ids.map((id) => overrides.get(id)).filter((value): value is number => value !== undefined)
    const uniqueOverrides = new Set(overrideCosts)
    const overriddenCost =
      overrideCosts.length > 0 && uniqueOverrides.size === 1 ? overrideCosts[0] : undefined
    return {
      catalogCost,
      cost: overriddenCost ?? catalogCost,
      overridden: overriddenCost !== undefined,
    }
  }

  const result: BusinessOrderProductCost[] = []

  for (const { order, rows: mergedItems } of pagedOrders) {
    const attachments = activeBusinessOrderAttachments(order)
    const salespersonName = displayProfileName(
      order.salesperson,
      order.salesperson_display_name_snapshot ?? order.salesperson_name_snapshot,
    )
    const outstandingAmount = outstandingByOrder.get(order.id) ?? 0
    const orderTotals = businessDailyOrderTotals(order)

    for (const item of mergedItems) {
      const { cost: effectiveCost, overridden, catalogCost } = resolveMergedCost(item)
      const quantity = Number(item.quantity)
      const representativeItemId = item.item_ids[0] ?? order.id

      result.push({
        order_id: order.id,
        item_id: representativeItemId,
        item_ids: item.item_ids,
        order_date: order.order_date,
        shipping_date: order.daily_shipping_date,
        shop_name: order.shop_name_snapshot,
        shop_group_name: order.shop_group_name_snapshot,
        salesperson_name: salespersonName,
        order_number: order.order_number,
        external_order_number: order.external_order_number,
        customer_name: getCustomerName(order.customer_snapshot),
        customer_tag_color: getCustomerTagColor(order),
        payment_account: order.payment_account,
        shipping_number: order.daily_shipping_number,
        shipping_category: item.daily_shipping_category ?? null,
        product_name: item.name_snapshot ?? '—',
        product_sku: item.display_sku ?? item.sku_snapshot ?? '',
        image_url: item.image_url_snapshot,
        quantity,
        shipping_progress: formatMergedBusinessDailyShippingProgress(item),
        unit_price: Number(item.unit_price),
        product_received_amount: Number(item.product_received_amount),
        logistics_fee_amount: item.logistics_fee_amount ?? null,
        sales_total_amount: Number(item.sales_total_amount),
        currency: order.currency,
        order_total_amount: Number(order.total_amount),
        order_sales_total_amount: orderTotals.salesTotal,
        outstanding_amount: outstandingAmount,
        order_status: order.status,
        order_closed_at: order.closed_at,
        payment_category: order.daily_payment_category,
        sales_notes: order.sales_notes,
        attachments,
        financial_number: financials.get(item.product_id ?? '')?.financial_number ?? null,
        financial_product_name: financials.get(item.product_id ?? '')?.product_name ?? null,
        catalog_cost: catalogCost,
        cost: effectiveCost,
        cost_overridden: overridden,
        total_cost: effectiveCost === null ? null : Math.round(effectiveCost * quantity * 10000) / 10000,
        fully_shipped: true,
        settled: false,
        settled_period: null,
      })
    }
  }

  return { rows: result, totalCount }
}

export function formatCostMoney(amount: number | null, currency: CurrencyCode) {
  if (amount === null || !Number.isFinite(amount)) return '—'
  return `${currency} ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
