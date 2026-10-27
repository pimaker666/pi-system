import { ReimbursementManager } from '@/components/reimbursement/reimbursement-manager'
import { hasFinanceViewFor, requireApproved } from '@/lib/auth'
import { chinaToday } from '@/lib/daily-order-costs-server'
import { createClient } from '@/lib/supabase/server'
import type { FinanceReimbursementRequest } from '@/types'

const LIST_LIMIT = 500

export default async function ReimbursementPage() {
  const profile = await requireApproved()
  const supabase = await createClient()

  const [requestsResult, canViewAll] = await Promise.all([
    supabase
      .from('finance_reimbursement_requests')
      .select(
        '*, applicant:profiles!finance_reimbursement_requests_applicant_id_fkey(id, chinese_name, full_name, email), reviewer:profiles!finance_reimbursement_requests_reviewed_by_fkey(id, chinese_name, full_name, email), completer:profiles!finance_reimbursement_requests_completed_by_fkey(id, chinese_name, full_name, email), items:finance_reimbursement_items(*)',
      )
      .order('created_at', { ascending: false })
      .limit(LIST_LIMIT),
    hasFinanceViewFor(profile),
  ])

  const requests = (requestsResult.data ?? []) as FinanceReimbursementRequest[]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">费用报销</h1>
        <p className="text-sm text-muted-foreground">
          提交日常报销申请，管理员审批并确认报销完成；金额仅用于报销流程与日记账对账，不影响记账金额。
        </p>
      </div>
      <ReimbursementManager
        requests={requests}
        canViewAll={canViewAll}
        canReview={profile.role === 'admin'}
        currentUserId={profile.id}
        today={chinaToday()}
      />
    </div>
  )
}
