import type { SupabaseClient } from '@supabase/supabase-js'
import type { DailyOrderProductCost, DailyOrderShippingCategory, Profile } from '@/types'
import { displayProfileName } from '@/lib/utils'

interface DailyOrderCostSourceRow {
  id: string
  order_date: string
  shop_name_snapshot: string
  salesperson_name_snapshot: string
  salesperson_display_name_snapshot: string | null
  order_number: string
  shipping_date: string
  shipping_category: DailyOrderShippingCategory
  product_id: string | null
  product_name_snapshot: string
  product_sku_snapshot: string
  quantity: number
  salesperson?: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'> | null
}

interface ProductFinancialRow {
  product_id: string
  financial_number: string | null
  product_name: string | null
  cost: number | null
}

interface CostOverrideRow {
  daily_order_id: string
  cost: number
}

export function chinaToday() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

const PAGE_SIZE = 1000

async function fetchAllDailyOrders(supabase: SupabaseClient) {
  const rows: DailyOrderCostSourceRow[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('finance_daily_orders')
      .select(`
        id, order_date, shop_name_snapshot, salesperson_name_snapshot,
        salesperson_display_name_snapshot, order_number,
        shipping_date, shipping_category, product_id, product_name_snapshot,
        product_sku_snapshot, quantity,
        salesperson:profiles!salesperson_id(id, chinese_name, full_name, email)
      `)
      .eq('status', 'active')
      .lte('shipping_date', chinaToday())
      .order('shipping_date', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`每日订单成本读取失败：${error.message}`)
    const page = (data ?? []) as unknown as DailyOrderCostSourceRow[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

async function fetchAllProductFinancials(supabase: SupabaseClient) {
  const rows: ProductFinancialRow[] = []
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
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('finance_daily_order_cost_overrides')
      .select('daily_order_id, cost')
      .order('daily_order_id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`订单行成本覆盖读取失败：${error.message}`)
    const page = (data ?? []) as CostOverrideRow[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

export async function fetchDailyOrderProductCosts(
  supabase: SupabaseClient,
): Promise<DailyOrderProductCost[]> {
  const [orders, financialRows, overrideRows] = await Promise.all([
    fetchAllDailyOrders(supabase),
    fetchAllProductFinancials(supabase),
    fetchAllCostOverrides(supabase),
  ])

  const financials = new Map(financialRows.map((row) => [row.product_id, row]))
  const overrides = new Map(overrideRows.map((row) => [row.daily_order_id, Number(row.cost)]))

  return orders.map((order) => {
    const isCustom = order.shipping_category === 'custom'
    const financial = !isCustom && order.product_id ? financials.get(order.product_id) : undefined
    const catalogCost = financial?.cost == null ? null : Number(financial.cost)
    const overriddenCost = overrides.get(order.id)

    return {
      daily_order_id: order.id,
      shipping_date: order.shipping_date,
      order_date: order.order_date,
      order_number: order.order_number,
      shop_name: order.shop_name_snapshot,
      salesperson_name: displayProfileName(
        order.salesperson,
        order.salesperson_display_name_snapshot || order.salesperson_name_snapshot,
      ),
      shipping_category: order.shipping_category,
      sales_product_name: order.product_name_snapshot,
      sales_product_sku: order.product_sku_snapshot,
      quantity: Number(order.quantity),
      financial_number: financial?.financial_number ?? null,
      financial_product_name: financial?.product_name ?? null,
      catalog_cost: catalogCost,
      cost: overriddenCost ?? catalogCost,
      cost_overridden: overriddenCost !== undefined,
    }
  })
}
