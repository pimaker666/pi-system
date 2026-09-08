import type { SupabaseClient } from '@supabase/supabase-js'
import type { DailyOrderFilters } from '@/schemas/daily-order'
import type { BusinessDailyLedgerOrder } from '@/lib/business-daily-orders'

/** 台账与导出的统一上限，和旧版每日订单台账保持一致。 */
export const BUSINESS_DAILY_LEDGER_LIMIT = 500

const LEDGER_TAIL =
  'salesperson:profiles!salesperson_id(id, chinese_name, full_name, email), business_order_attachments(*)'

/** 关键字里 PostgREST 的保留字符会破坏 or() 语法，先清掉。 */
function normalizeKeyword(raw: string) {
  return raw.replace(/[,()%*]/g, ' ').trim()
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
) {
  const keyword = normalizeKeyword(filters.q)
  // 发货分类落在明细上；下推到明细的筛选必须用 !inner，否则父订单不会被过滤。
  const needInner = Boolean(filters.category) || productSearch
  const itemsEmbed = needInner ? 'business_order_items!inner(*)' : 'business_order_items(*)'

  let query = supabase
    .from('business_orders')
    .select(`*, ${itemsEmbed}, ${LEDGER_TAIL}`)
    // 内嵌过滤只筛子行，不会误删没有附件的订单。
    .eq('business_order_attachments.status', 'active')
    .order('order_date', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .order('sort_order', { referencedTable: 'business_order_items', ascending: true })
    .limit(limit)

  if (filters.dateFrom) query = query.gte('order_date', filters.dateFrom)
  if (filters.dateTo) query = query.lte('order_date', filters.dateTo)
  if (filters.shop) query = query.eq('shop_id', filters.shop)
  if (filters.salesperson) query = query.eq('salesperson_id', filters.salesperson)
  if (filters.payment) query = query.eq('daily_payment_category', filters.payment)
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
 * 读取每日订单台账。PostgREST 不支持跨表 or()，所以关键字搜索拆成两次查询：
 * 一次匹配订单号 / 平台订单号 / 发货单号，一次匹配产品名称与 SKU，再按同一排序合并去重。
 * 表头命中的结果保留完整明细，优先于产品命中的结果。
 */
export async function fetchBusinessDailyLedger(
  supabase: SupabaseClient,
  filters: DailyOrderFilters,
  limit = BUSINESS_DAILY_LEDGER_LIMIT,
): Promise<BusinessDailyLedgerOrder[]> {
  const effectiveLimit = Math.min(limit, BUSINESS_DAILY_LEDGER_LIMIT)
  const keyword = normalizeKeyword(filters.q)

  if (!keyword) {
    const { data, error } = await buildLedgerQuery(supabase, filters, effectiveLimit, false)
    if (error) throw new Error(`每日订单台账读取失败：${error.message}`)
    return (data ?? []) as unknown as BusinessDailyLedgerOrder[]
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

  return [...merged.values()].sort(compareLedgerOrders).slice(0, effectiveLimit)
}
