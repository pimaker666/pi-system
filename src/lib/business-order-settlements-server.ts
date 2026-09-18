import type { SupabaseClient } from '@supabase/supabase-js'
import { displayProfileName } from '@/lib/utils'
import type { CurrencyCode, DailyOrderShippingCategory, SettledOrderRow } from '@/types'

const PAGE_SIZE = 1000

interface ProfileSnapshot {
  id: string
  chinese_name: string | null
  full_name: string | null
  email: string | null
}

interface SettlementQueryRow {
  business_order_item_id: string
  period: string
  unit_cost: number | string | null
  quantity: number | string
  settled_at: string
  settled_by_profile: ProfileSnapshot | null
  item: {
    id: string
    name_snapshot: string | null
    sku_snapshot: string | null
    daily_shipping_category: DailyOrderShippingCategory | null
    order: {
      id: string
      order_number: string
      external_order_number: string | null
      order_date: string
      currency: CurrencyCode
      shop_name_snapshot: string | null
      shop_group_name_snapshot: string | null
      customer_snapshot: unknown
      salesperson_name_snapshot: string | null
      salesperson_display_name_snapshot: string | null
      salesperson: ProfileSnapshot | null
    } | null
  } | null
}

const SELECT = `
  business_order_item_id,
  period,
  unit_cost,
  quantity,
  settled_at,
  settled_by_profile:profiles!settled_by(id, chinese_name, full_name, email),
  item:business_order_items!inner(
    id, name_snapshot, sku_snapshot, daily_shipping_category,
    order:business_orders!inner(
      id, order_number, external_order_number, order_date, currency,
      shop_name_snapshot, shop_group_name_snapshot, customer_snapshot,
      salesperson_name_snapshot, salesperson_display_name_snapshot,
      salesperson:profiles!salesperson_id(id, chinese_name, full_name, email)
    )
  )
`

function getCustomerName(customerSnapshot: unknown): string | null {
  if (!customerSnapshot || typeof customerSnapshot !== 'object') return null
  const snapshot = customerSnapshot as { name?: string | null; company?: string | null }
  return snapshot.company || snapshot.name || null
}

export interface SettledOrderFilters {
  period: string | null
  q: string
}

export function parseSettledOrderFilters(
  searchParams: Record<string, string | string[] | undefined>,
): SettledOrderFilters {
  const rawPeriod = searchParams.period
  const period = typeof rawPeriod === 'string' && /^\d{4}-\d{2}$/.test(rawPeriod) ? rawPeriod : null
  const rawQ = searchParams.q
  const q = (typeof rawQ === 'string' ? rawQ : '').trim()
  return { period, q }
}

/** 已结算年月列表（YYYY-MM，降序），供筛选下拉使用。 */
export async function fetchSettledPeriods(supabase: SupabaseClient): Promise<string[]> {
  const periods = new Set<string>()
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('finance_business_order_item_settlements')
      .select('period')
      .order('period', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`结算年月读取失败：${error.message}`)
    const page = (data ?? []) as Array<{ period: string }>
    for (const row of page) periods.add(String(row.period).slice(0, 7))
    if (page.length < PAGE_SIZE) break
  }
  return [...periods].sort((a, b) => (a < b ? 1 : -1))
}

export async function fetchSettledOrderRows(
  supabase: SupabaseClient,
  filters: SettledOrderFilters,
): Promise<SettledOrderRow[]> {
  const rows: SettledOrderRow[] = []
  const keyword = filters.q.toLocaleLowerCase()

  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from('finance_business_order_item_settlements')
      .select(SELECT)
      .order('period', { ascending: false })
      .order('settled_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (filters.period) query = query.eq('period', `${filters.period}-01`)

    const { data, error } = await query
    if (error) throw new Error(`已结算订单读取失败：${error.message}`)
    const page = (data ?? []) as unknown as SettlementQueryRow[]

    for (const record of page) {
      const item = record.item
      const order = item?.order
      if (!item || !order) continue

      const unitCost = record.unit_cost == null ? null : Number(record.unit_cost)
      const quantity = Number(record.quantity)
      const productName = item.name_snapshot ?? '—'
      const productSku = item.sku_snapshot ?? ''

      if (keyword) {
        const haystack = [
          order.order_number,
          order.external_order_number ?? '',
          productName,
          productSku,
        ]
          .join(' ')
          .toLocaleLowerCase()
        if (!haystack.includes(keyword)) continue
      }

      rows.push({
        business_order_item_id: record.business_order_item_id,
        order_id: order.id,
        order_number: order.order_number,
        external_order_number: order.external_order_number,
        order_date: order.order_date,
        shop_name: order.shop_name_snapshot,
        shop_group_name: order.shop_group_name_snapshot,
        salesperson_name: displayProfileName(
          order.salesperson,
          order.salesperson_display_name_snapshot ?? order.salesperson_name_snapshot,
        ),
        customer_name: getCustomerName(order.customer_snapshot),
        currency: order.currency,
        product_name: productName,
        product_sku: productSku,
        shipping_category: item.daily_shipping_category,
        quantity,
        unit_cost: unitCost,
        total_cost: unitCost == null ? null : Math.round(unitCost * quantity * 10000) / 10000,
        period: String(record.period).slice(0, 7),
        settled_by_name: record.settled_by_profile
          ? displayProfileName(record.settled_by_profile)
          : null,
        settled_at: record.settled_at,
      })
    }

    if (page.length < PAGE_SIZE) break
  }

  return rows
}
