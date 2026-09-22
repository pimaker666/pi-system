import { DailyOrderCostManager } from '@/components/finance/daily-order-cost-manager'
import {
  PiCostManager,
  type CostOrderOption,
} from '@/components/finance/pi-cost-manager'
import { requireFinanceAccess } from '@/lib/auth'
import { fetchBusinessOrderProductCosts } from '@/lib/business-order-costs-server'
import { parseBusinessOrderCostFilters } from '@/lib/business-order-cost'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'
import type { FinanceOrderCost } from '@/types'

export default async function FinanceCostsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireFinanceAccess()
  const filters = parseBusinessOrderCostFilters(await searchParams)
  const supabase = await createClient()

  const [legacyOrdersResult, businessOrdersResult, costsResult, options, dailyOrderCosts] =
    await Promise.all([
      supabase
        .from('finance_orders')
        .select('id, pi_number_snapshot, customer_name_snapshot')
        .eq('status', 'active')
        .order('order_date', { ascending: false }),
      supabase
        .from('business_orders')
        .select('id, order_number, customer_snapshot, customer:customers!customer_id(tag_color)')
        .in('status', ['approved', 'completed'])
        .is('voided_at', null)
        .order('order_date', { ascending: false }),
      supabase.from('finance_order_costs').select('*').order('incurred_date', { ascending: false }),
      fetchDailyOrderOptions(supabase),
      fetchBusinessOrderProductCosts(supabase, filters, filters.page),
    ])

  const loadError = legacyOrdersResult.error || businessOrdersResult.error || costsResult.error
  if (loadError) throw new Error(`订单成本数据读取失败：${loadError.message}`)

  const legacyOrders: CostOrderOption[] = (legacyOrdersResult.data ?? []).map((order) => ({
    id: order.id,
    source: 'finance',
    reference: order.pi_number_snapshot,
    customer: order.customer_name_snapshot,
    customer_tag_color: null,
  }))
  const businessOrders: CostOrderOption[] = (businessOrdersResult.data ?? []).map((order) => {
    const customer = order.customer_snapshot as { name?: string | null; company?: string | null; tag_color?: string | null }
    const liveCustomer = order.customer as { tag_color?: string | null } | undefined
    return {
      id: order.id,
      source: 'business',
      reference: order.order_number,
      customer: customer.company || customer.name || null,
      customer_tag_color: liveCustomer?.tag_color ?? customer.tag_color ?? null,
    }
  })
  const orders = [...businessOrders, ...legacyOrders]
  const costs = (costsResult.data ?? []) as FinanceOrderCost[]

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">订单成本</h1>
        <p className="text-sm text-muted-foreground">
          已收款并发货的产品行自动匹配产品库财务资料；修改成本仅覆盖当前订单产品行，不反写产品库。
        </p>
      </div>
      <DailyOrderCostManager
        rows={dailyOrderCosts.rows}
        totalCount={dailyOrderCosts.totalCount}
        filters={filters}
        options={options}
      />
      <div className="border-t pt-8">
        <h2 className="mb-1 text-lg font-semibold">其他订单费用</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          按历史 PI 或已审核业务订单归集采购、物流、关税、平台费和收款手续费等成本。
        </p>
        <PiCostManager orders={orders} costs={costs} />
      </div>
    </div>
  )
}
