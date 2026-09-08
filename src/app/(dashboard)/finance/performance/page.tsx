import {
  PerformanceManager,
  type BusinessOrderListRow,
} from '@/components/finance/performance-manager'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

export default async function FinancePerformancePage() {
  await requireApproved()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('business_orders')
    .select(
      '*, business_order_payment_allocations(amount, voided_at, transfer:business_customer_transfers!business_order_payment_allocations_transfer_id_fkey(voided_at, exchange_rate_to_cny)), salesperson:profiles!salesperson_id(id, chinese_name, full_name, email)',
    )
    .order('order_date', { ascending: false })
    .order('created_at', { ascending: false })

  if (error) throw new Error(`业务订单读取失败：${error.message}`)
  const orders = (data ?? []) as BusinessOrderListRow[]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">业务业绩</h1>
        <p className="text-sm text-muted-foreground">
          本页为业务订单的只读汇总，数据与每日订单同源；请前往每日订单查看详情或维护订单。
        </p>
      </div>
      <PerformanceManager orders={orders} />
    </div>
  )
}
