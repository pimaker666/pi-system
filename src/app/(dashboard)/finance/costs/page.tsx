import {
  PiCostManager,
  type CostOrderOption,
} from '@/components/finance/pi-cost-manager'
import { requireFinanceAccess } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import type { FinanceOrderCost } from '@/types'

export default async function FinanceCostsPage() {
  await requireFinanceAccess()
  const supabase = await createClient()

  const [legacyOrdersResult, businessOrdersResult, costsResult] = await Promise.all([
    supabase
      .from('finance_orders')
      .select('id, pi_number_snapshot, customer_name_snapshot')
      .eq('status', 'active')
      .order('order_date', { ascending: false }),
    supabase
      .from('business_orders')
      .select('id, order_number, customer_snapshot')
      .in('status', ['approved', 'completed'])
      .order('order_date', { ascending: false }),
    supabase.from('finance_order_costs').select('*').order('incurred_date', { ascending: false }),
  ])

  const loadError = legacyOrdersResult.error || businessOrdersResult.error || costsResult.error
  if (loadError) throw new Error(`订单成本数据读取失败：${loadError.message}`)

  const legacyOrders: CostOrderOption[] = (legacyOrdersResult.data ?? []).map((order) => ({
    id: order.id,
    source: 'finance',
    reference: order.pi_number_snapshot,
    customer: order.customer_name_snapshot,
  }))
  const businessOrders: CostOrderOption[] = (businessOrdersResult.data ?? []).map((order) => {
    const customer = order.customer_snapshot as { name?: string | null; company?: string | null }
    return {
      id: order.id,
      source: 'business',
      reference: order.order_number,
      customer: customer.company || customer.name || null,
    }
  })
  const orders = [...businessOrders, ...legacyOrders]
  const costs = (costsResult.data ?? []) as FinanceOrderCost[]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">订单成本</h1>
        <p className="text-sm text-muted-foreground">
          按历史 PI 或已审核业务订单归集采购、物流、关税、平台费和收款手续费等成本。
        </p>
      </div>
      <PiCostManager orders={orders} costs={costs} />
    </div>
  )
}
