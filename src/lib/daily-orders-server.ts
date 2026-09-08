import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  DailyOrder,
  DailyOrderChangeRequest,
  DailyOrderCommission,
  DailyOrderShop,
  DailyOrderShopGroup,
  DailyOrderWorkflow,
  Product,
  Profile,
} from '@/types'
import type { DailyOrderFilters } from '@/schemas/daily-order'
import type { DailyOrderShopOption } from '@/lib/daily-orders'

export const DAILY_ORDER_EXPORT_LIMIT = 500

// Live-join the salesperson profile so the UI can render the current chinese_name
// (falling back full_name → email). Disambiguated by the salesperson_id FK because
// the table has several FKs to profiles (created_by/updated_by/voided_by...).
const SALESPERSON_EMBED =
  'salesperson:profiles!salesperson_id(id, chinese_name, full_name, email)'

export async function fetchDailyOrders(
  supabase: SupabaseClient,
  filters: DailyOrderFilters,
  limit = DAILY_ORDER_EXPORT_LIMIT,
  includeScreenshots = false,
) {
  let query = supabase
    .from('finance_daily_orders')
    .select(
      includeScreenshots
        ? `*, finance_daily_order_screenshots(*), ${SALESPERSON_EMBED}`
        : `*, ${SALESPERSON_EMBED}`,
    )
    .eq('status', 'active')
    .order('order_date', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(Math.min(limit, DAILY_ORDER_EXPORT_LIMIT))

  if (includeScreenshots) query = query.eq('finance_daily_order_screenshots.status', 'active')
  if (filters.dateFrom) query = query.gte('order_date', filters.dateFrom)
  if (filters.dateTo) query = query.lte('order_date', filters.dateTo)
  if (filters.shop) query = query.eq('shop_id', filters.shop)
  if (filters.salesperson) query = query.eq('salesperson_id', filters.salesperson)
  if (filters.category) query = query.eq('shipping_category', filters.category)
  if (filters.payment) query = query.eq('payment_category', filters.payment)
  const q = filters.q.replace(/[,()%]/g, ' ').trim()
  if (q) {
    query = query.or(
      `order_number.ilike.%${q}%,shipping_number.ilike.%${q}%,product_name_snapshot.ilike.%${q}%,product_sku_snapshot.ilike.%${q}%`,
    )
  }

  const { data, error } = await query
  if (error) throw new Error(`每日订单读取失败：${error.message}`)
  return (data ?? []) as unknown as DailyOrder[]
}

export async function fetchDailyOrderOptions(supabase: SupabaseClient) {
  const [shopsResult, groupsResult, assignmentsResult, salesResult, productsResult] = await Promise.all([
    supabase.from('finance_daily_order_shops').select('*').order('name'),
    supabase.from('finance_daily_order_shop_groups').select('*').order('name'),
    supabase.from('finance_daily_order_shop_salespeople').select('*').eq('is_active', true),
    supabase.from('profiles').select('id, full_name, email, chinese_name').in('role', ['sales', 'supervisor', 'admin']).eq('status', 'approved').order('full_name'),
    supabase.from('products').select('id, name, sku, image_url, unit_price, currency, unit').eq('is_active', true).order('name'),
  ])
  const error = shopsResult.error || groupsResult.error || assignmentsResult.error || salesResult.error || productsResult.error
  if (error) throw new Error(`每日订单基础数据读取失败：${error.message}`)
  const assignments = (assignmentsResult.data ?? []) as Array<{ shop_id: string; salesperson_id: string }>
  const shops = ((shopsResult.data ?? []) as DailyOrderShop[]).map((shop): DailyOrderShopOption => ({
    ...shop,
    salespersonIds: assignments.filter((row) => row.shop_id === shop.id).map((row) => row.salesperson_id),
  }))
  return {
    shops,
    groups: (groupsResult.data ?? []) as DailyOrderShopGroup[],
    salespeople: (salesResult.data ?? []) as Pick<Profile, 'id' | 'full_name' | 'email' | 'chinese_name'>[],
    products: (productsResult.data ?? []) as Pick<Product, 'id' | 'name' | 'sku' | 'image_url' | 'unit_price' | 'currency' | 'unit'>[],
  }
}

export const WORKFLOW_LIST_LIMIT = 200

/** A workflow header enriched with the count of its product-line rows. */
export interface DailyOrderWorkflowSummary extends DailyOrderWorkflow {
  order_line_count: number
}

/**
 * Workflows visible to the current actor (RLS scopes rows: finance/admin see all,
 * sales see their own, supervisors see subordinates'). Optionally filter by status.
 */
export async function fetchDailyOrderWorkflows(
  supabase: SupabaseClient,
  options: { statuses?: string[]; limit?: number } = {},
): Promise<DailyOrderWorkflowSummary[]> {
  let query = supabase
    .from('finance_daily_order_workflows')
    .select(`*, finance_daily_orders(count), ${SALESPERSON_EMBED}`)
    .order('updated_at', { ascending: false })
    .limit(Math.min(options.limit ?? WORKFLOW_LIST_LIMIT, WORKFLOW_LIST_LIMIT))
  if (options.statuses && options.statuses.length > 0) query = query.in('status', options.statuses)

  const { data, error } = await query
  if (error) throw new Error(`订单工作流读取失败：${error.message}`)
  return ((data ?? []) as Array<DailyOrderWorkflow & { finance_daily_orders?: Array<{ count: number }> }>).map(
    ({ finance_daily_orders, ...workflow }) => ({
      ...workflow,
      order_line_count: finance_daily_orders?.[0]?.count ?? 0,
    }),
  )
}

/** Full detail for a single workflow: header + its product-line order rows. */
export async function fetchDailyOrderWorkflowDetail(
  supabase: SupabaseClient,
  workflowId: string,
): Promise<{ workflow: DailyOrderWorkflow; orders: DailyOrder[] } | null> {
  const { data: workflow, error } = await supabase
    .from('finance_daily_order_workflows')
    .select(`*, ${SALESPERSON_EMBED}`)
    .eq('id', workflowId)
    .maybeSingle()
  if (error) throw new Error(`订单工作流读取失败：${error.message}`)
  if (!workflow) return null

  const { data: orders, error: ordersError } = await supabase
    .from('finance_daily_orders')
    .select('*')
    .eq('workflow_id', workflowId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (ordersError) throw new Error(`订单明细读取失败：${ordersError.message}`)

  return { workflow: workflow as DailyOrderWorkflow, orders: (orders ?? []) as unknown as DailyOrder[] }
}

/**
 * Change requests visible to the current actor (RLS: finance/admin all, requester own,
 * supervisor subordinates'). Filter by status for the finance review queue.
 */
export async function fetchDailyOrderChangeRequests(
  supabase: SupabaseClient,
  options: { statuses?: string[]; limit?: number } = {},
): Promise<DailyOrderChangeRequest[]> {
  let query = supabase
    .from('finance_daily_order_change_requests')
    .select('*')
    .order('requested_at', { ascending: false })
    .limit(Math.min(options.limit ?? WORKFLOW_LIST_LIMIT, WORKFLOW_LIST_LIMIT))
  if (options.statuses && options.statuses.length > 0) query = query.in('status', options.statuses)

  const { data, error } = await query
  if (error) throw new Error(`改动申请读取失败：${error.message}`)
  return (data ?? []) as DailyOrderChangeRequest[]
}

/** Commission for a workflow. Finance/admin only (RLS blocks sales/supervisor). */
export async function fetchDailyOrderCommission(
  supabase: SupabaseClient,
  workflowId: string,
): Promise<DailyOrderCommission | null> {
  const { data, error } = await supabase
    .from('finance_daily_order_commissions')
    .select('*')
    .eq('workflow_id', workflowId)
    .maybeSingle()
  if (error) throw new Error(`提成读取失败：${error.message}`)
  return (data as DailyOrderCommission) ?? null
}
