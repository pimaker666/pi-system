import {
  PerformanceManager,
  type BusinessOrderListRow,
} from '@/components/finance/performance-manager'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

export default async function FinancePerformancePage() {
  const profile = await requireApproved()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('business_orders')
    .select(
      '*, business_order_payments(amount, voided_at), salesperson:profiles!salesperson_id(id, chinese_name, full_name, email)',
    )
    .order('order_date', { ascending: false })
    .order('created_at', { ascending: false })

  if (error) throw new Error(`业务订单读取失败：${error.message}`)
  const orders = (data ?? []) as BusinessOrderListRow[]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {profile.role === 'sales' ? '我的业绩' : '业务业绩'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {profile.role === 'sales'
            ? '从客户和产品库创建业务订单，登记收款凭证后提交管理员审核。'
            : '查看业务订单、审核进度、收款与工资核算状态。'}
        </p>
      </div>
      <PerformanceManager profile={profile} orders={orders} />
    </div>
  )
}
