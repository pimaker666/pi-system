import type { SupabaseClient } from '@supabase/supabase-js'
import type { DailyOrderFilters } from '@/schemas/daily-order'
import type { BusinessDailyLedgerOrder } from '@/lib/business-daily-orders'
import type { CurrencyCode } from '@/types'
import {
  applyBusinessOrderItemDisplay,
  fetchProductFinancialLabels,
} from '@/lib/business-order-financials'
import { fetchProductFinancialLabelsCached } from '@/lib/business-order-financials-server'

/** 台账页面展示上限，和旧版每日订单台账保持一致。 */
export const BUSINESS_DAILY_LEDGER_LIMIT = 500

/** 导出上限，高于页面展示上限，避免一次导出行数被展示上限卡住。 */
export const BUSINESS_DAILY_EXPORT_LIMIT = 2000

const LEDGER_TAIL = `
  salesperson:profiles!salesperson_id(id, chinese_name, full_name, email),
  customer:customers!customer_id(tag_color),
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

/** 台账尾部两项 attach（产品财务标签、实时客户国家）互不依赖，取数并行后在内存合并。 */
async function attachLedgerDisplays(
  supabase: SupabaseClient,
  orders: BusinessDailyLedgerOrder[],
  viewerRole?: string,
): Promise<BusinessDailyLedgerOrder[]> {
  if (orders.length === 0) return orders
  const [labelled, countries] = await Promise.all([
    attachItemDisplayLabels(supabase, orders, viewerRole),
    fetchCurrentCustomerCountries(
      supabase,
      orders.map((order) => order.id),
    ),
  ])
  return labelled.map((order) => ({
    ...order,
    current_customer_country: countries.get(order.id) ?? null,
  }))
}

/** 给台账明细附加财务展示字段：产品名称/财务编号优先于销售快照。 */
async function attachItemDisplayLabels(
  supabase: SupabaseClient,
  orders: BusinessDailyLedgerOrder[],
  viewerRole?: string,
): Promise<BusinessDailyLedgerOrder[]> {
  const items = orders.flatMap((order) => order.business_order_items ?? [])
  const hasLinkedProducts = items.some(
    (item) => item.source_type !== 'custom' && item.product_id,
  )
  if (!hasLinkedProducts) return orders
  const labels =
    viewerRole === undefined
      ? await fetchProductFinancialLabels(supabase)
      : await fetchProductFinancialLabelsCached(supabase, viewerRole)
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
  offset: number,
  limit: number,
  productSearch: boolean,
  ids?: string[],
) {
  const keyword = normalizeKeyword(filters.q)
  // 发货分类落在明细上；下推到明细的筛选必须用 !inner，否则父订单不会被过滤。
  const needInner = filters.categories.length > 0 || productSearch
  const itemsEmbed = needInner ? 'business_order_items!inner(*)' : 'business_order_items(*)'
  // 标记按账号隔离（RLS 只返回本人行）；筛选时用 !inner 才能过滤掉未标记订单。
  const marksEmbed = filters.markedOnly
    ? 'business_order_marks!inner(order_id)'
    : 'business_order_marks(order_id)'

  let query = supabase
    .from('business_orders')
    .select(`*, ${itemsEmbed}, ${marksEmbed}, ${LEDGER_TAIL}`)
    // 内嵌过滤只筛子行，不会误删没有附件的订单。
    .eq('business_order_attachments.status', 'active')
    .order('order_date', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .order('sort_order', { referencedTable: 'business_order_items', ascending: true })
    .range(offset, offset + limit - 1)

  if (ids && ids.length > 0) query = query.in('id', ids)
  if (filters.dateFrom) query = query.gte('order_date', filters.dateFrom)
  if (filters.dateTo) query = query.lte('order_date', filters.dateTo)
  if (filters.shops.length > 0) query = query.in('shop_id', filters.shops)
  if (filters.shopGroups.length > 0) query = query.in('shop_group_id', filters.shopGroups)
  if (filters.salespeople.length > 0) query = query.in('salesperson_id', filters.salespeople)
  // 记录状态按勾选项取并集：正常（含特殊关闭）、仅特殊关闭、仅已作废。
  const recordStatuses = new Set(filters.recordStatuses)
  if (recordStatuses.size > 0) {
    const hasActive = recordStatuses.has('active')
    const hasSpecial = recordStatuses.has('special_closed')
    const hasVoided = recordStatuses.has('voided')
    if (hasActive && hasVoided) {
      // 未作废 ∪ 已作废 = 全部记录
    } else if (hasActive) {
      query = query.is('voided_at', null)
    } else if (hasSpecial && hasVoided) {
      // 特殊关闭（未作废且有 closed_at）∪ 已作废 = closed_at 非空 ∪ voided_at 非空
      query = query.or('closed_at.not.is.null,voided_at.not.is.null')
    } else if (hasSpecial) {
      query = query.is('voided_at', null).not('closed_at', 'is', null)
    } else {
      query = query.not('voided_at', 'is', null)
    }
  }
  if (filters.payments.length > 0) query = query.in('daily_payment_category', filters.payments)
  const bindingStatuses = new Set(filters.customerBindingStatuses)
  if (bindingStatuses.size === 1) {
    if (bindingStatuses.has('bound')) query = query.not('customer_id', 'is', null)
    else if (bindingStatuses.has('unbound')) query = query.is('customer_id', null)
  }
  if (filters.fulfillmentStatuses.length > 0) {
    query = query.in('fulfillment_status', filters.fulfillmentStatuses)
  }
  if (filters.completions.length === 1 && filters.completions[0] === 'completed') {
    query = query.eq('fulfillment_status', 'fully_shipped')
  }
  if (filters.categories.length > 0) {
    query = query.in('business_order_items.daily_shipping_category', filters.categories)
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
 * 因此收款是否收齐只能在 JS 侧判断。多选时按并集保留。
 */
function applyCompletionFilter(
  orders: BusinessDailyLedgerOrder[],
  completions: DailyOrderFilters['completions'],
): BusinessDailyLedgerOrder[] {
  const wantCompleted = completions.includes('completed')
  const wantIncomplete = completions.includes('incomplete')
  if (wantCompleted === wantIncomplete) return orders
  return orders.filter((order) => {
    const completed =
      order.fulfillment_status === 'fully_shipped' && order.outstanding_amount <= 0
    return wantCompleted ? completed : !completed
  })
}

function applyBalanceStatusFilter(
  orders: BusinessDailyLedgerOrder[],
  balanceStatuses: DailyOrderFilters['balanceStatuses'],
): BusinessDailyLedgerOrder[] {
  const wantSettled = balanceStatuses.includes('settled')
  const wantUnsettled = balanceStatuses.includes('unsettled')
  if (wantSettled === wantUnsettled) return orders
  return orders.filter((order) =>
    wantSettled ? order.outstanding_amount === 0 : order.outstanding_amount !== 0,
  )
}

function isOrderFullyInSet(order: BusinessDailyLedgerOrder, itemIdSet: Set<string>) {
  const itemIds = (order.business_order_items ?? []).map((item) => item.id)
  return itemIds.length > 0 && itemIds.every((id) => itemIdSet.has(id))
}

/**
 * 结算状态后过滤：结算按明细行记录（finance_business_order_item_settlements）。
 * 订单级判定——该订单本次读到的所有明细行都已结算才算“已结算”。空数组不过滤。
 */
function applySettlementFilter(
  orders: BusinessDailyLedgerOrder[],
  settlementStatuses: DailyOrderFilters['settlementStatuses'],
  settledItemIdSet: Set<string>,
): BusinessDailyLedgerOrder[] {
  const wantSettled = settlementStatuses.includes('settled')
  const wantUnsettled = settlementStatuses.includes('unsettled')
  if (wantSettled === wantUnsettled) return orders
  return orders.filter(
    (order) => isOrderFullyInSet(order, settledItemIdSet) === wantSettled,
  )
}

function applyCommissionClearanceFilter(
  orders: BusinessDailyLedgerOrder[],
  commissionClearanceStatuses: DailyOrderFilters['commissionClearanceStatuses'],
  clearedItemIdSet: Set<string>,
): BusinessDailyLedgerOrder[] {
  const wantCleared = commissionClearanceStatuses.includes('cleared')
  const wantUncleared = commissionClearanceStatuses.includes('uncleared')
  if (wantCleared === wantUncleared) return orders
  return orders.filter(
    (order) => isOrderFullyInSet(order, clearedItemIdSet) === wantCleared,
  )
}

export interface BusinessDailyLedgerCurrencySummary {
  currency: CurrencyCode
  receivable: number
  productReceived: number
  shippingReceived: number
  salesTotal: number
  outstanding: number
}

export interface BusinessDailyLedgerPageSummary {
  totalCount: number
  page: number
  pageSize: number
  orderIds: string[]
  currencies: BusinessDailyLedgerCurrencySummary[]
}

function toAmount(value: unknown): number {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : 0
}

/**
 * 汇总卡片与分页订单 id 一次取回。
 * SQL 侧已复刻台账的基础筛选与后过滤（完成/尾款/结算/提成结清），
 * 页面不再需要先拉 500 单明细再在 JS 里求和。
 */
export async function fetchBusinessDailyLedgerSummary(
  supabase: SupabaseClient,
  filters: DailyOrderFilters,
  page: number,
  pageSize: number,
): Promise<BusinessDailyLedgerPageSummary> {
  const { data, error } = await supabase.rpc('get_business_daily_order_ledger', {
    p_date_from: filters.dateFrom ?? null,
    p_date_to: filters.dateTo ?? null,
    p_shops: filters.shops,
    p_shop_groups: filters.shopGroups,
    p_salespeople: filters.salespeople,
    p_record_statuses: filters.recordStatuses,
    p_payments: filters.payments,
    p_customer_bindings: filters.customerBindingStatuses,
    p_fulfillments: filters.fulfillmentStatuses,
    p_completions: filters.completions,
    p_balance_statuses: filters.balanceStatuses,
    p_settlement_statuses: filters.settlementStatuses,
    p_commission_statuses: filters.commissionClearanceStatuses,
    p_categories: filters.categories,
    p_marked_only: filters.markedOnly === '1',
    p_keyword: normalizeKeyword(filters.q),
    p_page: page,
    p_page_size: pageSize,
  })
  if (error) throw new Error(`每日订单汇总读取失败：${error.message}`)

  const payload = (data ?? {}) as {
    totalCount?: number
    page?: number
    pageSize?: number
    orderIds?: unknown[]
    currencies?: Array<Record<string, unknown>>
  }
  return {
    totalCount: toAmount(payload.totalCount),
    page: toAmount(payload.page) || 1,
    pageSize: toAmount(payload.pageSize) || pageSize,
    orderIds: (payload.orderIds ?? []).map((id) => String(id)),
    currencies: (payload.currencies ?? []).map((row) => ({
      currency: row.currency as CurrencyCode,
      receivable: toAmount(row.receivable),
      productReceived: toAmount(row.productReceived),
      shippingReceived: toAmount(row.shippingReceived),
      salesTotal: toAmount(row.salesTotal),
      outstanding: toAmount(row.outstanding),
    })),
  }
}

/**
 * 取台账某一页的订单明细。订单 id 已由汇总 RPC 按全部筛选与后过滤挑好，
 * 这里只做展示用途的取数，避免用后过滤再筛一遍导致行数与汇总口径不一致。
 */
export async function fetchBusinessDailyLedgerPage(
  supabase: SupabaseClient,
  filters: DailyOrderFilters,
  orderIds: string[],
  viewerRole?: string,
): Promise<BusinessDailyLedgerResult> {
  if (orderIds.length === 0) {
    return { orders: [], settledItemIds: [], confirmedCommissionItemIds: [] }
  }
  const displayFilters: DailyOrderFilters = {
    ...filters,
    completions: [],
    balanceStatuses: [],
    settlementStatuses: [],
    commissionClearanceStatuses: [],
  }
  return fetchBusinessDailyLedgerWithStatusSets(
    supabase,
    displayFilters,
    orderIds.length,
    orderIds,
    viewerRole,
  )
}

export interface BusinessDailyLedgerResult {
  orders: BusinessDailyLedgerOrder[]
  settledItemIds: string[]
  confirmedCommissionItemIds: string[]
}

const LEDGER_FETCH_PAGE_SIZE = 500
// 完成后过滤在内存里做，筛选很挑剔时要持续翻页；超过该上限说明范围过大，报错而非静默截断。
const LEDGER_SOURCE_MAX = 20000

async function fetchLedgerCandidates(
  supabase: SupabaseClient,
  filters: DailyOrderFilters,
  keyword: string,
  offset: number,
  pageSize: number,
  ids?: string[],
): Promise<{ orders: BusinessDailyLedgerOrder[]; exhausted: boolean }> {
  const merged = new Map<string, BusinessDailyLedgerOrder>()

  if (ids && ids.length > 0) {
    // Kong 网关 URI 上限约 8k：.in('id', ids) 一批最多 100 个订单，超出拆分查询后按同一排序合并。
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100)
      if (keyword) {
        // 订单 id 由汇总选好，但命中产品的关键字仍要保留该订单的命中明细：
        // 订单字段查询只筛父行，产品查询走内联 join，两者取并集后表头命中优先。
        const [headResult, itemResult] = await Promise.all([
          buildLedgerQuery(supabase, filters, 0, pageSize, false, batch),
          buildLedgerQuery(supabase, filters, 0, pageSize, true, batch),
        ])
        const error = headResult.error || itemResult.error
        if (error) throw new Error(`每日订单台账读取失败：${error.message}`)
        for (const order of (itemResult.data ?? []) as unknown as BusinessDailyLedgerOrder[]) {
          merged.set(order.id, order)
        }
        for (const order of (headResult.data ?? []) as unknown as BusinessDailyLedgerOrder[]) {
          merged.set(order.id, order)
        }
        continue
      }
      const { data, error } = await buildLedgerQuery(
        supabase,
        filters,
        0,
        pageSize,
        false,
        batch,
      )
      if (error) throw new Error(`每日订单台账读取失败：${error.message}`)
      for (const order of (data ?? []) as unknown as BusinessDailyLedgerOrder[]) {
        merged.set(order.id, order)
      }
    }
    return { orders: [...merged.values()], exhausted: true }
  }

  if (!keyword) {
    const { data, error } = await buildLedgerQuery(supabase, filters, offset, pageSize, false)
    if (error) throw new Error(`每日订单台账读取失败：${error.message}`)
    const page = (data ?? []) as unknown as BusinessDailyLedgerOrder[]
    return { orders: page, exhausted: page.length < pageSize }
  }

  const [headResult, itemResult] = await Promise.all([
    buildLedgerQuery(supabase, filters, offset, pageSize, false),
    buildLedgerQuery(supabase, filters, offset, pageSize, true),
  ])
  const error = headResult.error || itemResult.error
  if (error) throw new Error(`每日订单台账读取失败：${error.message}`)

  const head = (headResult.data ?? []) as unknown as BusinessDailyLedgerOrder[]
  const item = (itemResult.data ?? []) as unknown as BusinessDailyLedgerOrder[]
  for (const order of head) merged.set(order.id, order)
  for (const order of item) {
    if (!merged.has(order.id)) merged.set(order.id, order)
  }
  return {
    orders: [...merged.values()],
    exhausted: head.length < pageSize && item.length < pageSize,
  }
}

/**
 * 读取每日订单台账。PostgREST 不支持跨表 or()，所以关键字搜索拆成两次查询：
 * 一次匹配订单号 / 平台订单号 / 发货单号 / 收款账户，一次匹配产品名称与 SKU，再按同一排序合并去重。
 * 表头命中的结果保留完整明细，优先于产品命中的结果。
 */
export async function fetchBusinessDailyLedgerWithStatusSets(
  supabase: SupabaseClient,
  filters: DailyOrderFilters,
  limit = BUSINESS_DAILY_LEDGER_LIMIT,
  ids?: string[],
  viewerRole?: string,
  includeStatusSets = true,
): Promise<BusinessDailyLedgerResult> {
  const effectiveLimit = Math.min(limit, BUSINESS_DAILY_EXPORT_LIMIT)
  const keyword = normalizeKeyword(filters.q)
  // 未收金额由 RPC 事后附加，结算/提成结清按明细行单独读取；三者互不依赖，并行发出。
  const needSettled = includeStatusSets || filters.settlementStatuses.length > 0
  const needCleared = includeStatusSets || filters.commissionClearanceStatuses.length > 0

  const collected: BusinessDailyLedgerOrder[] = []
  const seenOrderIds = new Set<string>()
  const settledItemIdsAll = new Set<string>()
  const confirmedCommissionItemIdsAll = new Set<string>()
  let offset = 0

  // 后过滤会丢弃部分行，持续翻页直到凑满目标行数或数据取尽。
  while (collected.length < effectiveLimit) {
    if (offset >= LEDGER_SOURCE_MAX) {
      throw new Error(`每日订单台账达到 ${LEDGER_SOURCE_MAX} 单扫描上限，请缩小筛选范围后再试`)
    }
    const page = await fetchLedgerCandidates(
      supabase,
      filters,
      keyword,
      offset,
      LEDGER_FETCH_PAGE_SIZE,
      ids,
    )
    const fresh = page.orders.filter((order) => !seenOrderIds.has(order.id))
    for (const order of fresh) seenOrderIds.add(order.id)

    if (fresh.length > 0) {
      const [withOutstanding, settledItemIds, confirmedCommissionItemIds] = await Promise.all([
        attachOutstandingAmounts(supabase, fresh),
        needSettled
          ? fetchSettledItemIdsForOrders(supabase, fresh)
          : Promise.resolve<string[]>([]),
        needCleared
          ? fetchConfirmedCommissionItemIdsForOrders(supabase, fresh)
          : Promise.resolve<string[]>([]),
      ])
      for (const id of settledItemIds) settledItemIdsAll.add(id)
      for (const id of confirmedCommissionItemIds) confirmedCommissionItemIdsAll.add(id)

      collected.push(
        ...applyCommissionClearanceFilter(
          applySettlementFilter(
            applyBalanceStatusFilter(
              applyCompletionFilter(withOutstanding, filters.completions),
              filters.balanceStatuses,
            ),
            filters.settlementStatuses,
            new Set(settledItemIds),
          ),
          filters.commissionClearanceStatuses,
          new Set(confirmedCommissionItemIds),
        ),
      )
    }

    if (page.exhausted) break
    offset += LEDGER_FETCH_PAGE_SIZE
  }

  const orders = collected.sort(compareLedgerOrders).slice(0, effectiveLimit)

  return {
    orders: await attachLedgerDisplays(supabase, orders, viewerRole),
    settledItemIds: [...settledItemIdsAll],
    confirmedCommissionItemIds: [...confirmedCommissionItemIdsAll],
  }
}

export async function fetchBusinessDailyLedger(
  supabase: SupabaseClient,
  filters: DailyOrderFilters,
  limit = BUSINESS_DAILY_LEDGER_LIMIT,
  ids?: string[],
  viewerRole?: string,
): Promise<BusinessDailyLedgerOrder[]> {
  const result = await fetchBusinessDailyLedgerWithStatusSets(
    supabase,
    filters,
    limit,
    ids,
    viewerRole,
    false,
  )
  return result.orders
}

/**
 * 读取台账中这批订单已结算的明细行 id 集合（供“结算状态”列判断）。
 * 走只暴露明细行 id 的视图，结算表的成本列仍然只对财务开放。
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
  // Kong 网关 URI 上限约 8k，一批 500 个 UUID 的 in() 查询会触发 414，必须压到 100。
  const CHUNK = 100
  for (let i = 0; i < itemIds.length; i += CHUNK) {
    const chunk = itemIds.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from('business_order_item_settlement_flags')
      .select('business_order_item_id')
      .in('business_order_item_id', chunk)
    if (error) throw new Error(`结算状态读取失败：${error.message}`)
    for (const row of (data ?? []) as Array<{ business_order_item_id: string }>) {
      settled.push(row.business_order_item_id)
    }
  }
  return settled
}

/**
 * 读取台账中这批订单已确认结清的提成明细行 id 集合（供“提成”列判断）。
 * 只有业务员确认（confirmed）的明细才算已结清，pending / rejected 均视为未结清。
 */
export async function fetchConfirmedCommissionItemIdsForOrders(
  supabase: SupabaseClient,
  orders: BusinessDailyLedgerOrder[],
): Promise<string[]> {
  const itemIds = orders.flatMap((order) =>
    (order.business_order_items ?? []).map((item) => item.id),
  )
  if (itemIds.length === 0) return []

  const confirmed: string[] = []
  const CHUNK = 100
  for (let i = 0; i < itemIds.length; i += CHUNK) {
    const chunk = itemIds.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from('finance_business_order_item_commission_clearances')
      .select('business_order_item_id')
      .eq('status', 'confirmed')
      .in('business_order_item_id', chunk)
    if (error) throw new Error(`提成结清状态读取失败：${error.message}`)
    for (const row of (data ?? []) as Array<{ business_order_item_id: string }>) {
      confirmed.push(row.business_order_item_id)
    }
  }
  return confirmed
}
