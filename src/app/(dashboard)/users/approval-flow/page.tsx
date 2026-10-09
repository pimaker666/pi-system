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
        <h1 className="text-2xl font-semibold">订单操作审批流</h1>
        <p className="text-sm text-muted-foreground">配置订单编辑、取消结清和取消结算的审核规则。</p>
      </div>
      <PermissionPageNav active="/users/approval-flow" />
      <ApprovalFlowOverview rules={rules} />
    </div>
  )
}
