import { ApprovalFlowOverview } from '@/components/users/approval-flow-overview'
import { PermissionPageNav } from '@/components/users/permission-page-nav'
import { requireAdmin } from '@/lib/auth'
import { getOrderEditApprovalRules } from '@/lib/actions/permissions'

export default async function ApprovalFlowPage() {
  await requireAdmin()
  const rules = await getOrderEditApprovalRules()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">订单编辑审批流</h1>
        <p className="text-sm text-muted-foreground">查看当前订单审批流程，并为后续自定义审核规则预留配置入口。</p>
      </div>
      <PermissionPageNav active="/users/approval-flow" />
      <ApprovalFlowOverview rules={rules} />
    </div>
  )
}
