import { PiCostManager } from '@/components/finance/pi-cost-manager'
import { requireFinanceAccess } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import type { FinanceOrder, FinanceOrderCost } from '@/types'

export default async function FinanceCostsPage() {
  await requireFinanceAccess()
  const supabase = await createClient()

  const [ordersResult, costsResult] = await Promise.all([
    supabase
      .from('finance_orders')
      .select('id, pi_number_snapshot, customer_name_snapshot')
      .eq('status', 'active')
      .order('order_date', { ascending: false }),
    supabase.from('finance_order_costs').select('*').order('incurred_date', { ascending: false }),
  ])

  const orders = (ordersResult.data ?? []) as Pick<
    FinanceOrder,
    'id' | 'pi_number_snapshot' | 'customer_name_snapshot'
  >[]
  const costs = (costsResult.data ?? []) as FinanceOrderCost[]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">订单成本</h1>
        <p className="text-sm text-muted-foreground">
          按已登记 PI 归集采购、物流、关税、平台费和收款手续费等成本。
        </p>
      </div>
      <PiCostManager orders={orders} costs={costs} />
    </div>
  )
}
