import { requireApproved } from '@/lib/auth'
import {
  fetchApprovalInbox,
  fetchApprovalPendingCount,
  fetchApprovalSideTodos,
} from '@/lib/approvals-server'
import { ApprovalCenter } from '@/components/approvals/approval-center'
import type { ApprovalInboxScope } from '@/types'

const SCOPES: ApprovalInboxScope[] = ['pending', 'mine', 'done']

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>
}) {
  await requireApproved()
  const { scope: rawScope } = await searchParams
  const scope = SCOPES.includes(rawScope as ApprovalInboxScope)
    ? (rawScope as ApprovalInboxScope)
    : 'pending'
  const [items, pendingCount, sideTodos] = await Promise.all([
    fetchApprovalInbox(scope),
    fetchApprovalPendingCount(),
    scope === 'pending' ? fetchApprovalSideTodos() : Promise.resolve([]),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">审批中心</h1>
        <p className="text-sm text-muted-foreground">
          查看待你审批、你发起的申请，以及历史处理记录；通过后业务动作会自动执行。
        </p>
      </div>
      <ApprovalCenter
        scope={scope}
        items={items}
        pendingCount={pendingCount}
        sideTodos={sideTodos}
      />
    </div>
  )
}
