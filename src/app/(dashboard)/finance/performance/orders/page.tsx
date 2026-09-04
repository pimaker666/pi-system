import { DailyOrderWorkflowList } from '@/components/finance/daily-order-workflow-list'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { fetchDailyOrderWorkflows } from '@/lib/daily-orders-server'

export default async function DailyOrderWorkflowsPage() {
  const profile = await requireApproved()
  const supabase = await createClient()
  const workflows = await fetchDailyOrderWorkflows(supabase)

  const isSales = profile.role === 'sales'
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{isSales ? '我的每日订单' : '每日订单认领'}</h1>
        <p className="text-sm text-muted-foreground">
          {isSales
            ? '认领归属你的每日订单，绑定客户后提交业绩审核；如需修改订单信息可发起改动申请。'
            : '查看每日订单的认领、客户绑定与业绩审核进度。'}
        </p>
      </div>
      <DailyOrderWorkflowList workflows={workflows} />
    </div>
  )
}
