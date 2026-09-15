import type { SupabaseClient } from '@supabase/supabase-js'
import type { BusinessOrderProductCost, CurrencyCode } from '@/types'
import type { BusinessOrderCostFilters } from '@/schemas/business-order-cost'
import { displayProfileName } from '@/lib/utils'
import {
  activeBusinessOrderAttachments,
  businessDailyItemAmounts,
  businessDailyOrderTotals,
  formatBusinessDailyShippingProgress,
  sortedBusinessDailyItems,
  type BusinessDailyLedgerOrder,
} from '@/lib/business-daily-orders'
import { BUSINESS_DAILY_LEDGER_LIMIT } from '@/lib/business-daily-orders-server'

export { BUSINESS_DAILY_LEDGER_LIMIT }

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
  business_order_returns(*, business_order_return_items(*))
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
  limit: number,
  productSearch: boolean,
) {
  const keyword = normalizeKeyword(filters.q)
  const needInner = productSearch
  const itemsEmbed = needInner ? 'business_order_items!inner(*)' : 'business_order_items(*)'

  let query = supabase
    .from('business_orders')
    .select(`*, ${itemsEmbed}, ${LEDGER_TAIL}`)
    .eq('business_order_attachments.status', 'active')
    .order('order_date', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .order('sort_order', { referencedTable: 'business_order_items', ascending: true })
    .limit(limit)

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
  limit: number,
): Promise<BusinessDailyLedgerOrder[]> {
  const keyword = normalizeKeyword(filters.q)

  if (!keyword) {
    const { data, error } = await buildBaseQuery(supabase, filters, limit, false)
    if (error) throw new Error(`订单成本订单读取失败：${error.message}`)
    return (data ?? []) as unknown as BusinessDailyLedgerOrder[]
  }

  const [headResult, itemResult] = await Promise.all([
    buildBaseQuery(supabase, filters, limit, false),
    buildBaseQuery(supabase, filters, limit, true),
  ])
  const error = headResult.error || itemResult.error
  if (error) throw new Error(`订单成本订单读取失败：${error.message}`)

  const merged = new Map<string, BusinessDailyLedgerOrder>()
  for (const order of (headResult.data ?? []) as unknown as BusinessDailyLedgerOrder[]) {
    merged.set(order.id, order)
  }
  for (const order of (itemResult.data ?? []) as unknown as BusinessDailyLedgerOrder[]) {
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

function getCustomerName(customerSnapshot: unknown): string | null {
  if (!customerSnapshot || typeof customerSnapshot !== 'object') return null
  const snapshot = customerSnapshot as { name?: string | null; company?: string | null }
  return snapshot.company || snapshot.name || null
}

export async function fetchBusinessOrderProductCosts(
  supabase: SupabaseClient,
  filters: BusinessOrderCostFilters,
  limit = BUSINESS_DAILY_LEDGER_LIMIT,
): Promise<BusinessOrderProductCost[]> {
  const effectiveLimit = Math.min(limit, BUSINESS_DAILY_LEDGER_LIMIT)
  const [orders, financialRows, overrideRows] = await Promise.all([
    fetchMatchingOrders(supabase, filters, effectiveLimit),
    fetchAllProductFinancials(supabase),
    fetchAllCostOverrides(supabase),
  ])

  const financials = new Map(financialRows.map((row) => [row.product_id, row]))
  const overrides = new Map(overrideRows.map((row) => [row.business_order_item_id, Number(row.cost)]))

  const { data: outstandingData, error: outstandingError } = await supabase.rpc(
    'get_business_orders_outstanding_amount',
    { p_order_ids: orders.map((order) => order.id) },
  )
  if (outstandingError) throw new Error(`订单成本未收尾款读取失败：${outstandingError.message}`)
  const outstandingByOrder = new Map(
    ((outstandingData ?? []) as Array<{ order_id: string; outstanding_amount: number | string }>).map((row) => [
      row.order_id,
      Number(row.outstanding_amount),
    ]),
  )

  const result: BusinessOrderProductCost[] = []

  for (const order of orders) {
    const items = sortedBusinessDailyItems(order)
    const attachments = activeBusinessOrderAttachments(order)
    const salespersonName = displayProfileName(
      order.salesperson,
      order.salesperson_display_name_snapshot ?? order.salesperson_name_snapshot,
    )
    const outstandingAmount = outstandingByOrder.get(order.id) ?? 0
    const fullyShipped = order.fulfillment_status === 'fully_shipped'
    const orderTotals = businessDailyOrderTotals(order)

    for (const item of items.length > 0 ? items : [null]) {
      const productId = item?.product_id
      const isCustom = item?.daily_shipping_category === 'custom'
      const financial = !isCustom && productId ? financials.get(productId) : undefined
      const catalogCost = financial?.cost == null ? null : Number(financial.cost)
      const overriddenCost = item ? overrides.get(item.id) : undefined
      const effectiveCost = fullyShipped ? (overriddenCost ?? catalogCost) : null
      const quantity = item ? Number(item.quantity) : 0
      const amounts = item ? businessDailyItemAmounts(item) : null

      result.push({
        order_id: order.id,
        item_id: item?.id ?? order.id,
        order_date: order.order_date,
        shipping_date: order.daily_shipping_date,
        shop_name: order.shop_name_snapshot,
        shop_group_name: order.shop_group_name_snapshot,
        salesperson_name: salespersonName,
        order_number: order.order_number,
        external_order_number: order.external_order_number,
        customer_name: getCustomerName(order.customer_snapshot),
        payment_account: order.payment_account,
        shipping_number: order.daily_shipping_number,
        shipping_category: item?.daily_shipping_category ?? null,
        product_name: item?.name_snapshot ?? '—',
        product_sku: item?.sku_snapshot ?? '',
        quantity,
        shipping_progress: item ? formatBusinessDailyShippingProgress(order, item) : '—',
        unit_price: amounts ? amounts.unitPrice : 0,
        product_received_amount: amounts ? amounts.productReceived : 0,
        logistics_fee_amount: amounts ? amounts.logisticsFee : null,
        sales_total_amount: amounts ? amounts.salesTotal : 0,
        currency: order.currency,
        order_total_amount: Number(order.total_amount),
        order_sales_total_amount: orderTotals.salesTotal,
        outstanding_amount: outstandingAmount,
        order_status: order.status,
        order_closed_at: order.closed_at,
        payment_category: order.daily_payment_category,
        sales_notes: order.sales_notes,
        attachments,
        financial_number: financial?.financial_number ?? null,
        financial_product_name: financial?.product_name ?? null,
        catalog_cost: catalogCost,
        cost: effectiveCost,
        cost_overridden: overriddenCost !== undefined,
        total_cost: effectiveCost === null ? null : Math.round(effectiveCost * quantity * 10000) / 10000,
        fully_shipped: fullyShipped,
      })
    }
  }

  return result
}

export function formatCostMoney(amount: number | null, currency: CurrencyCode) {
  if (amount === null || !Number.isFinite(amount)) return '—'
  return `${currency} ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
