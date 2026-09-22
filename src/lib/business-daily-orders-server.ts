import type { SupabaseClient } from '@supabase/supabase-js'
import type { DailyOrderFilters } from '@/schemas/daily-order'
import type { BusinessDailyLedgerOrder } from '@/lib/business-daily-orders'
import {
  applyBusinessOrderItemDisplay,
  fetchProductFinancialLabels,
} from '@/lib/business-order-financials'

/** 台账页面展示上限，和旧版每日订单台账保持一致。 */
export const BUSINESS_DAILY_LEDGER_LIMIT = 500

/** 导出上限，高于页面展示上限，避免一次导出行数被展示上限卡住。 */
export const BUSINESS_DAILY_EXPORT_LIMIT = 2000

const LEDGER_TAIL = `
  salesperson:profiles!salesperson_id(id, chinese_name, full_name, email),
  business_order_attachments(*),
  business_order_shipments(*, business_order_shipment_items(*)),
  business_order_returns(*, business_order_return_items(*)),
  business_order_payment_allocations(order_item_id, allocation_target, amount, voided_at, transfer:business_customer_transfers(voided_at))
`

async function attachOutstandingAmounts(
  supabase: SupabaseClient,
  orders: BusinessDailyLedgerOrder[],
): Promise<BusinessDailyLedgerOrder[]> {
  if (orders.length === 0) return []

  const { data, error } = await supabase.rpc('get_business_orders_outstanding_amount', {
    p_order_ids: orders.map((order) => order.id),
  })
  if (error) throw new Error(`每日订单未收尾款读取失败：${error.message}`)

  const amounts = new Map(
    ((data ?? []) as Array<{ order_id: string; outstanding_amount: number | string }>)
      .map((row) => [row.order_id, Number(row.outstanding_amount)]),
  )
  return orders.map((order) => ({
    ...order,
    outstanding_amount: amounts.get(order.id) ?? 0,
  }))
}

/** 关键字里 PostgREST 的保留字符会破坏 or() 语法，先清掉。 */
function normalizeKeyword(raw: string) {
  return raw.replace(/[,()%*]/g, ' ').trim()
}

/**
 * 按订单 id 批量取“当前”客户国家（读 customers 表实时值，非下单快照）。
 * 走 security definer 的 get_business_orders_customer_country，可见范围由订单级
 * 权限收敛，财务也能拿到别人名下客户的国家。未关联客户的订单不返回，Map 里缺省。
 */
export async function fetchCurrentCustomerCountries(
  supabase: SupabaseClient,
  orderIds: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>()
  if (orderIds.length === 0) return result
  const { data, error } = await supabase.rpc('get_business_orders_customer_country', {
    p_order_ids: orderIds,
  })
  if (error) throw new Error(`订单客户国家读取失败：${error.message}`)
  for (const row of (data ?? []) as Array<{ order_id: string; country: string | null }>) {
    result.set(row.order_id, row.country)
  }
  return result
}

async function attachCurrentCustomerCountry(
  supabase: SupabaseClient,
  orders: BusinessDailyLedgerOrder[],
): Promise<BusinessDailyLedgerOrder[]> {
  if (orders.length === 0) return orders
  const countries = await fetchCurrentCustomerCountries(
    supabase,
    orders.map((order) => order.id),
  )
  return orders.map((order) => ({
    ...order,
    current_customer_country: countries.get(order.id) ?? null,
  }))
}

/** 给台账明细附加财务展示字段：产品名称/财务编号优先于销售快照。 */
async function attachItemDisplayLabels(
  supabase: SupabaseClient,
  orders: BusinessDailyLedgerOrder[],
): Promise<BusinessDailyLedgerOrder[]> {
  const items = orders.flatMap((order) => order.business_order_items ?? [])
  const hasLinkedProducts = items.some(
    (item) => item.source_type !== 'custom' && item.product_id,
  )
  if (!hasLinkedProducts) return orders
  const labels = await fetchProductFinancialLabels(supabase)
  return orders.map((order) => ({
    ...order,
    business_order_items: (order.business_order_items ?? []).map((item) =>
      applyBusinessOrderItemDisplay(item, labels),
    ),
  }))
}

/**
 * 台账查询。`productSearch` 为 true 时把关键字下推到产品明细（内联 join，
 * 只保留命中产品的订单及其命中明细），与旧台账“一行一个产品”的搜索语义一致。
 */
function buildLedgerQuery(
  supabase: SupabaseClient,
  filters: DailyOrderFilters,
  limit: number,
  productSearch: boolean,
  ids?: string[],
) {
  const keyword = normalizeKeyword(filters.q)
  // 发货分类落在明细上；下推到明细的筛选必须用 !inner，否则父订单不会被过滤。
  const needInner = Boolean(filters.category) || productSearch
  const itemsEmbed = needInner ? 'business_order_items!inner(*)' : 'business_order_items(*)'

  let query = supabase
    .from('business_orders')
    .select(`*, ${itemsEmbed}, ${LEDGER_TAIL}`)
    .is('voided_at', null)
    // 内嵌过滤只筛子行，不会误删没有附件的订单。
    .eq('business_order_attachments.status', 'active')
    .order('order_date', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .order('sort_order', { referencedTable: 'business_order_items', ascending: true })
    .limit(limit)

  if (ids && ids.length > 0) query = query.in('id', ids)
  if (filters.dateFrom) query = query.gte('order_date', filters.dateFrom)
  if (filters.dateTo) query = query.lte('order_date', filters.dateTo)
  if (filters.shop) query = query.eq('shop_id', filters.shop)
  if (filters.shopGroup) query = query.eq('shop_group_id', filters.shopGroup)
  if (filters.salesperson) query = query.eq('salesperson_id', filters.salesperson)
  if (filters.payment) query = query.eq('daily_payment_category', filters.payment)
  if (filters.completion === 'completed') {
    query = query.eq('fulfillment_status', 'fully_shipped')
  }
  if (filters.category) {
    query = query.eq('business_order_items.daily_shipping_category', filters.category)
  }

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

function compareLedgerOrders(left: BusinessDailyLedgerOrder, right: BusinessDailyLedgerOrder) {
  if (left.order_date !== right.order_date) return left.order_date < right.order_date ? 1 : -1
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1
  return left.id < right.id ? 1 : -1
}

/**
 * 完成状态后过滤：outstanding_amount 在 SQL 查询之后由 RPC 附加，
 * 因此收款是否收齐只能在 JS 侧判断。
 */
function applyCompletionFilter(
  orders: BusinessDailyLedgerOrder[],
  completion: DailyOrderFilters['completion'],
): BusinessDailyLedgerOrder[] {
  if (!completion) return orders
  if (completion === 'completed') return orders.filter((o) => o.outstanding_amount <= 0)
  return orders.filter((o) => o.fulfillment_status !== 'fully_shipped' || o.outstanding_amount > 0)
}

function applyBalanceStatusFilter(
  orders: BusinessDailyLedgerOrder[],
  balanceStatus: DailyOrderFilters['balanceStatus'],
): BusinessDailyLedgerOrder[] {
  if (!balanceStatus) return orders
  if (balanceStatus === 'settled') return orders.filter((order) => order.outstanding_amount === 0)
  return orders.filter((order) => order.outstanding_amount !== 0)
}

/**
 * 读取每日订单台账。PostgREST 不支持跨表 or()，所以关键字搜索拆成两次查询：
 * 一次匹配订单号 / 平台订单号 / 发货单号 / 收款账户，一次匹配产品名称与 SKU，再按同一排序合并去重。
 * 表头命中的结果保留完整明细，优先于产品命中的结果。
 */
export async function fetchBusinessDailyLedger(
  supabase: SupabaseClient,
  filters: DailyOrderFilters,
  limit = BUSINESS_DAILY_LEDGER_LIMIT,
  ids?: string[],
): Promise<BusinessDailyLedgerOrder[]> {
  const effectiveLimit = Math.min(limit, BUSINESS_DAILY_EXPORT_LIMIT)
  const keyword = normalizeKeyword(filters.q)

  if (ids && ids.length > 0 || !keyword) {
    const { data, error } = await buildLedgerQuery(supabase, filters, effectiveLimit, false, ids)
    if (error) throw new Error(`每日订单台账读取失败：${error.message}`)
    const orders = applyBalanceStatusFilter(
      applyCompletionFilter(
        await attachOutstandingAmounts(
          supabase,
          (data ?? []) as unknown as BusinessDailyLedgerOrder[],
        ),
        filters.completion,
      ),
      filters.balanceStatus,
    )
    return attachCurrentCustomerCountry(supabase, await attachItemDisplayLabels(supabase, orders))
  }

  const [headResult, itemResult] = await Promise.all([
    buildLedgerQuery(supabase, filters, effectiveLimit, false),
    buildLedgerQuery(supabase, filters, effectiveLimit, true),
  ])
  const error = headResult.error || itemResult.error
  if (error) throw new Error(`每日订单台账读取失败：${error.message}`)

  const merged = new Map<string, BusinessDailyLedgerOrder>()
  for (const order of (headResult.data ?? []) as unknown as BusinessDailyLedgerOrder[]) {
    merged.set(order.id, order)
  }
  for (const order of (itemResult.data ?? []) as unknown as BusinessDailyLedgerOrder[]) {
    if (!merged.has(order.id)) merged.set(order.id, order)
  }

  return attachCurrentCustomerCountry(
    supabase,
    await attachItemDisplayLabels(
      supabase,
      applyBalanceStatusFilter(
        applyCompletionFilter(
          await attachOutstandingAmounts(
            supabase,
            [...merged.values()].sort(compareLedgerOrders).slice(0, effectiveLimit),
          ),
          filters.completion,
        ),
        filters.balanceStatus,
      ),
    ),
  )
}

/**
 * 读取台账中这批订单已结算的明细行 id 集合（供“结算状态”列判断）。
 * 结算表 select 对所有已认证用户开放，因此 sales 也能看到结算状态。
 */
export async function fetchSettledItemIdsForOrders(
  supabase: SupabaseClient,
  orders: BusinessDailyLedgerOrder[],
): Promise<string[]> {
  const itemIds = orders.flatMap((order) =>
    (order.business_order_items ?? []).map((item) => item.id),
  )
  if (itemIds.length === 0) return []

  const settled: string[] = []
  const CHUNK = 500
  for (let i = 0; i < itemIds.length; i += CHUNK) {
    const chunk = itemIds.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from('finance_business_order_item_settlements')
      .select('business_order_item_id')
      .in('business_order_item_id', chunk)
    if (error) throw new Error(`结算状态读取失败：${error.message}`)
    for (const row of (data ?? []) as Array<{ business_order_item_id: string }>) {
      settled.push(row.business_order_item_id)
    }
  }
  return settled
}
