import { ApprovalRuleSettings } from '@/components/users/approval-rule-settings'
import { PermissionPageNav } from '@/components/users/permission-page-nav'
import { requireAdmin } from '@/lib/auth'
import { fetchApprovalApprovers, fetchApprovalRules } from '@/lib/approvals-server'

export default async function ApprovalFlowPage() {
  await requireAdmin()
  const [rules, approvers] = await Promise.all([fetchApprovalRules(), fetchApprovalApprovers()])
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">审批流</h1>
        <p className="text-sm text-muted-foreground">
          为订单审核、订单编辑、加单改行、作废与成本覆盖配置开关、金额条件与审核人；审批通过后业务动作自动执行。
        </p>
      </div>
      <PermissionPageNav active="/users/approval-flow" />
      <ApprovalRuleSettings rules={rules} approvers={approvers} />
    </div>
  )
}
