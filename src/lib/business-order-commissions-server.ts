import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  BusinessOrderCommissionRow,
  CommissionCategoryRate,
  CustomerCommissionTag,
  CustomerCustomOrderCommissionRate,
  DailyOrderShippingCategory,
} from '@/types'
import type { BusinessOrderCommissionFilters } from '@/schemas/business-order-commission'
import { displayProfileName } from '@/lib/utils'
import { COMMISSION_PAGE_SIZE } from '@/lib/business-order-commission'
import {
  businessOrderAllocationBreakdown,
  mergeBusinessDailyItems,
  type BusinessDailyLedgerOrder,
} from '@/lib/business-daily-orders'

const COMMISSION_ORDER_LIMIT = 1000

interface ItemCommissionRow {
  business_order_item_id: string
  commission_rate: number
}

interface OrderCommissionRow {
  business_order_id: string
  freight_cost: number
  freight_commission_rate: number
  settlement_exchange_rate_to_cny: number | null
}

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

function buildOrdersQuery(
  supabase: SupabaseClient,
  filters: BusinessOrderCommissionFilters,
  productSearch: boolean,
) {
  const keyword = normalizeKeyword(filters.q)
  const itemsEmbed = productSearch ? 'business_order_items!inner(*)' : 'business_order_items(*)'

  let query = supabase
    .from('business_orders')
    .select(
      `*, ${itemsEmbed}, salesperson:profiles!salesperson_id(id, chinese_name, full_name, email), customer:customers!customer_id(tag_color), business_order_payment_allocations(order_item_id, allocation_target, amount, voided_at, transfer:business_customer_transfers(voided_at))`,
    )
    .is('voided_at', null)
    .not('customer_id', 'is', null)
    .order('order_date', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .order('sort_order', { referencedTable: 'business_order_items', ascending: true })
    .range(0, COMMISSION_ORDER_LIMIT - 1)

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
  filters: BusinessOrderCommissionFilters,
): Promise<BusinessDailyLedgerOrder[]> {
  const keyword = normalizeKeyword(filters.q)

  if (!keyword) {
    const { data, error } = await buildOrdersQuery(supabase, filters, false)
    if (error) throw new Error(`业务提成订单读取失败：${error.message}`)
    return (data ?? []) as unknown as BusinessDailyLedgerOrder[]
  }

  const [headResult, itemResult] = await Promise.all([
    buildOrdersQuery(supabase, filters, false),
    buildOrdersQuery(supabase, filters, true),
  ])
  const error = headResult.error || itemResult.error
  if (error) throw new Error(`业务提成订单读取失败：${error.message}`)

  const merged = new Map<string, BusinessDailyLedgerOrder>()
  for (const order of (headResult.data ?? []) as unknown as BusinessDailyLedgerOrder[]) {
    merged.set(order.id, order)
  }
  for (const order of (itemResult.data ?? []) as unknown as BusinessDailyLedgerOrder[]) {
    if (!merged.has(order.id)) merged.set(order.id, order)
  }

  return [...merged.values()].sort(compareOrders)
}

async function fetchAllCategoryRates(supabase: SupabaseClient): Promise<CommissionCategoryRate[]> {
  const { data, error } = await supabase
    .from('finance_commission_category_rates')
    .select('category, product_commission_rate')
  if (error) throw new Error(`发货分类提点读取失败：${error.message}`)
  return ((data ?? []) as Array<{ category: DailyOrderShippingCategory; product_commission_rate: number | string }>).map(
    (row) => ({ category: row.category, product_commission_rate: Number(row.product_commission_rate) }),
  )
}

async function fetchAllCustomerCommissionTags(
  supabase: SupabaseClient,
): Promise<CustomerCommissionTag[]> {
  const { data, error } = await supabase
    .from('finance_customer_commission_tags')
    .select('tag_color, label, product_commission_rate, sort_order')
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true })
  if (error) throw new Error(`客户标记提点读取失败：${error.message}`)
  return ((data ?? []) as Array<{
    tag_color: string
    label: string
    product_commission_rate: number | string
    sort_order: number | string
  }>).map((row) => ({
    tag_color: row.tag_color,
    label: row.label,
    product_commission_rate: Number(row.product_commission_rate),
    sort_order: Number(row.sort_order),
  }))
}

async function fetchAllCustomerCustomOrderCommissionRates(
  supabase: SupabaseClient,
): Promise<CustomerCustomOrderCommissionRate[]> {
  const { data, error } = await supabase
    .from('finance_customer_custom_order_commission_rates')
    .select('maximum_custom_order_count, product_commission_rate')
    .order('maximum_custom_order_count', { ascending: true })
  if (error) throw new Error(`定制订单数提点读取失败：${error.message}`)
  return ((data ?? []) as Array<{
    maximum_custom_order_count: number | string
    product_commission_rate: number | string
  }>).map((row) => ({
    maximum_custom_order_count: Number(row.maximum_custom_order_count),
    product_commission_rate: Number(row.product_commission_rate),
  }))
}

async function fetchCustomerTagColors(
  supabase: SupabaseClient,
  orderIds: string[],
): Promise<Map<string, string | null>> {
  const colors = new Map<string, string | null>()
  if (orderIds.length === 0) return colors
  const { data, error } = await supabase.rpc('get_business_order_customer_tag_colors', {
    p_order_ids: orderIds,
  })
  if (error) throw new Error(`客户标记读取失败：${error.message}`)
  for (const row of (data ?? []) as Array<{ order_id: string; tag_color: string | null }>) {
    colors.set(row.order_id, row.tag_color)
  }
  return colors
}

async function fetchCustomOrderCounts(
  supabase: SupabaseClient,
  customerIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (customerIds.length === 0) return counts
  const { data, error } = await supabase.rpc('get_customer_order_stats', {
    p_customer_ids: customerIds,
  })
  if (error) throw new Error(`客户定制订单数读取失败：${error.message}`)
  for (const row of (data ?? []) as Array<{ customer_id: string; custom_order_count: number | null }>) {
    counts.set(row.customer_id, Number(row.custom_order_count ?? 0))
  }
  return counts
}

async function fetchAllItemCommissions(supabase: SupabaseClient) {
  const rows: ItemCommissionRow[] = []
  const PAGE_SIZE = 1000
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('finance_business_order_item_commissions')
      .select('business_order_item_id, commission_rate')
      .order('business_order_item_id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`产品提点覆盖读取失败：${error.message}`)
    const page = (data ?? []) as Array<{ business_order_item_id: string; commission_rate: number | string }>
    for (const row of page) {
      rows.push({ business_order_item_id: row.business_order_item_id, commission_rate: Number(row.commission_rate) })
    }
    if (page.length < PAGE_SIZE) return rows
  }
}

async function fetchAllOrderCommissions(supabase: SupabaseClient) {
  const rows: OrderCommissionRow[] = []
  const PAGE_SIZE = 1000
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('finance_business_order_commissions')
      .select('business_order_id, freight_cost, freight_commission_rate, settlement_exchange_rate_to_cny')
      .order('business_order_id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`订单运费提成读取失败：${error.message}`)
    const page = (data ?? []) as Array<{
      business_order_id: string
      freight_cost: number | string
      freight_commission_rate: number | string
      settlement_exchange_rate_to_cny: number | string | null
    }>
    for (const row of page) {
      rows.push({
        business_order_id: row.business_order_id,
        freight_cost: Number(row.freight_cost),
        freight_commission_rate: Number(row.freight_commission_rate),
        settlement_exchange_rate_to_cny: row.settlement_exchange_rate_to_cny == null
          ? null
          : Number(row.settlement_exchange_rate_to_cny),
      })
    }
    if (page.length < PAGE_SIZE) return rows
  }
}

interface ClearanceRow {
  business_order_item_id: string
  status: import('@/types').CommissionClearanceStatus
  period: string
}

async function fetchAllCommissionClearances(supabase: SupabaseClient): Promise<ClearanceRow[]> {
  const rows: ClearanceRow[] = []
  const PAGE_SIZE = 1000
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('finance_business_order_item_commission_clearances')
      .select('business_order_item_id, status, period')
      .order('business_order_item_id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`提成结清记录读取失败：${error.message}`)
    const page = (data ?? []) as Array<{
      business_order_item_id: string
      status: import('@/types').CommissionClearanceStatus
      period: string
    }>
    for (const row of page) {
      rows.push({
        business_order_item_id: row.business_order_item_id,
        status: row.status,
        period: row.period.slice(0, 7),
      })
    }
    if (page.length < PAGE_SIZE) return rows
  }
}

function getCustomerName(customerSnapshot: unknown): string | null {
  if (!customerSnapshot || typeof customerSnapshot !== 'object') return null
  const snapshot = customerSnapshot as { name?: string | null; company?: string | null }
  return snapshot.company || snapshot.name || null
}

function getCustomerTagColor(order: BusinessDailyLedgerOrder): string | null {
  const liveColor = (order.customer as { tag_color?: string | null } | undefined)?.tag_color
  if (liveColor) return liveColor
  if (!order.customer_snapshot || typeof order.customer_snapshot !== 'object') return null
  return (order.customer_snapshot as { tag_color?: string | null }).tag_color ?? null
}

function round4(value: number) {
  return Math.round(value * 10000) / 10000
}

export async function fetchBusinessOrderCommissions(
  supabase: SupabaseClient,
  filters: BusinessOrderCommissionFilters,
  page = 1,
  pageSize = COMMISSION_PAGE_SIZE,
): Promise<{
  rows: BusinessOrderCommissionRow[]
  totalCount: number
  categoryRates: CommissionCategoryRate[]
  customerTags: CustomerCommissionTag[]
  customOrderRates: CustomerCustomOrderCommissionRate[]
}> {
  const [allOrders, categoryRates, itemCommissions, orderCommissions, customerTags, customOrderRates, clearances] = await Promise.all([
    fetchMatchingOrders(supabase, filters),
    fetchAllCategoryRates(supabase),
    fetchAllItemCommissions(supabase),
    fetchAllOrderCommissions(supabase),
    fetchAllCustomerCommissionTags(supabase),
    fetchAllCustomerCustomOrderCommissionRates(supabase),
    fetchAllCommissionClearances(supabase),
  ])

  const categoryRateMap = new Map(categoryRates.map((row) => [row.category, row.product_commission_rate]))
  const itemRateMap = new Map(itemCommissions.map((row) => [row.business_order_item_id, row.commission_rate]))
  const orderFreightMap = new Map(orderCommissions.map((row) => [row.business_order_id, row]))
  const tagMap = new Map(customerTags.map((tag) => [tag.tag_color.toLowerCase(), tag]))
  const clearanceMap = new Map(clearances.map((row) => [row.business_order_item_id, row]))

  const offset = (page - 1) * pageSize
  const pagedOrders = allOrders.slice(offset, offset + pageSize)

  const customerIds = [
    ...new Set(
      pagedOrders
        .map((order) => order.customer_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ]
  const [customOrderCounts, customerTagColors] = await Promise.all([
    fetchCustomOrderCounts(supabase, customerIds),
    fetchCustomerTagColors(supabase, pagedOrders.map((order) => order.id)),
  ])

  const rows: BusinessOrderCommissionRow[] = []

  for (const order of pagedOrders) {
    const salespersonName = displayProfileName(
      order.salesperson,
      order.salesperson_display_name_snapshot ?? order.salesperson_name_snapshot,
    )
    const freight = orderFreightMap.get(order.id)
    const { shippingTotal } = businessOrderAllocationBreakdown(order)
    const declaredFreightReceived = order.total_shipping_received_amount == null
      ? 0
      : Number(order.total_shipping_received_amount)
    const freightReceived = round4(declaredFreightReceived + shippingTotal)
    const freightCost = freight ? freight.freight_cost : 0
    const freightRate = freight ? freight.freight_commission_rate : 0
    const freightProfit = round4(freightReceived - freightCost)
    const freightCommission = round4((freightProfit * freightRate) / 100)

    const tagColor = customerTagColors.has(order.id)
      ? customerTagColors.get(order.id) ?? null
      : getCustomerTagColor(order)
    const tag = tagColor ? tagMap.get(tagColor.toLowerCase()) ?? null : null
    const tagRate = tag ? tag.product_commission_rate : null
    const customOrderCount = order.customer_id ? customOrderCounts.get(order.customer_id) ?? 0 : 0
    const customOrderRate = customOrderRates
      .find((rate) => rate.maximum_custom_order_count >= customOrderCount)?.product_commission_rate ?? null

    const mergedItems = mergeBusinessDailyItems(order)
    const orderRowSpan = mergedItems.length

    mergedItems.forEach((item, index) => {
      const category = item.daily_shipping_category
      const categoryDefault = category ? categoryRateMap.get(category) ?? null : null
      const overrideRates = item.item_ids
        .map((id) => itemRateMap.get(id))
        .filter((value): value is number => value !== undefined)
      const uniqueOverrides = new Set(overrideRates)
      const overriddenRate =
        overrideRates.length > 0 && uniqueOverrides.size === 1 ? overrideRates[0] : undefined
      const productCommissionRateSource =
        overriddenRate !== undefined
          ? 'override'
          : tagRate !== null
            ? 'customer_tag'
            : customOrderRate !== null
              ? 'custom_order_count'
              : categoryDefault !== null
                ? 'shipping_category'
                : 'none'
      const effectiveRate = overriddenRate ?? tagRate ?? customOrderRate ?? categoryDefault ?? 0
      const productReceived = Number(item.product_received_amount)
      const productCommission = round4((productReceived * effectiveRate) / 100)
      const representativeItemId = item.item_ids[0] ?? order.id

      // 合并行中任一明细行有结清记录即视为该合并行已结清；多行状态冲突时取 confirmed > pending > rejected。
      const itemClearances = item.item_ids
        .map((id) => clearanceMap.get(id))
        .filter((value): value is ClearanceRow => value !== undefined)
      const clearance = itemClearances.reduce<ClearanceRow | undefined>((acc, current) => {
        if (!acc) return current
        const priority: Record<import('@/types').CommissionClearanceStatus, number> = {
          confirmed: 3,
          pending: 2,
          rejected: 1,
        }
        return priority[current.status] > priority[acc.status] ? current : acc
      }, undefined)

      rows.push({
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
        customer_tag_color: tagColor,
        customer_tag_label: tag ? tag.label : null,
        custom_order_count: customOrderCount,
        shipping_category: category,
        product_name: item.name_snapshot ?? '—',
        product_sku: item.display_sku ?? item.sku_snapshot ?? '',
        image_url: item.image_url_snapshot,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        product_received_amount: productReceived,
        currency: order.currency,
        order_total_amount: Number(order.total_amount),
        product_commission_rate: effectiveRate,
        product_commission_rate_source: productCommissionRateSource,
        product_commission_rate_overridden: overriddenRate !== undefined,
        category_default_rate: categoryDefault,
        custom_order_count_rate: customOrderRate,
        product_commission_amount: productCommission,
        freight_received_amount: freightReceived,
        freight_cost: freightCost,
        freight_profit: freightProfit,
        freight_commission_rate: freightRate,
        freight_commission_amount: freightCommission,
        settlement_exchange_rate_to_cny: freight?.settlement_exchange_rate_to_cny ?? null,
        is_order_lead_row: index === 0,
        order_row_span: orderRowSpan,
        clearance_status: clearance?.status ?? null,
        clearance_period: clearance?.period ?? null,
      })
    })
  }

  return { rows, totalCount: allOrders.length, categoryRates, customerTags, customOrderRates }
}
