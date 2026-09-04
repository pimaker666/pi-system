import type { SupabaseClient } from '@supabase/supabase-js'
import type { DailyOrder, DailyOrderShop, Product, Profile } from '@/types'
import type { DailyOrderFilters } from '@/schemas/daily-order'
import type { DailyOrderShopOption } from '@/components/finance/daily-order-form'

export const DAILY_ORDER_EXPORT_LIMIT = 500

export async function fetchDailyOrders(
  supabase: SupabaseClient,
  filters: DailyOrderFilters,
  limit = DAILY_ORDER_EXPORT_LIMIT,
  includeScreenshots = false,
) {
  let query = supabase
    .from('finance_daily_orders')
    .select(includeScreenshots ? '*, finance_daily_order_screenshots(*)' : '*')
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
  const [shopsResult, assignmentsResult, salesResult, productsResult] = await Promise.all([
    supabase.from('finance_daily_order_shops').select('*').order('name'),
    supabase.from('finance_daily_order_shop_salespeople').select('*').eq('is_active', true),
    supabase.from('profiles').select('id, full_name, email').eq('role', 'sales').eq('status', 'approved').order('full_name'),
    supabase.from('products').select('id, name, sku').eq('is_active', true).order('name'),
  ])
  const error = shopsResult.error || assignmentsResult.error || salesResult.error || productsResult.error
  if (error) throw new Error(`每日订单基础数据读取失败：${error.message}`)
  const assignments = (assignmentsResult.data ?? []) as Array<{ shop_id: string; salesperson_id: string }>
  const shops = ((shopsResult.data ?? []) as DailyOrderShop[]).map((shop): DailyOrderShopOption => ({
    ...shop,
    salespersonIds: assignments.filter((row) => row.shop_id === shop.id).map((row) => row.salesperson_id),
  }))
  return {
    shops,
    salespeople: (salesResult.data ?? []) as Pick<Profile, 'id' | 'full_name' | 'email'>[],
    products: (productsResult.data ?? []) as Pick<Product, 'id' | 'name' | 'sku'>[],
  }
}
