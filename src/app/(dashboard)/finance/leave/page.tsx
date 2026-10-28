import { LeaveManager } from '@/components/finance/leave-manager'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import type { LeaveRequestWithProfile, Profile } from '@/types'

export default async function LeaveRequestsPage() {
  const profile = await requireApproved()
  const canManage = profile.role === 'admin' || profile.role === 'finance'
  const supabase = await createClient()

  let query = supabase
    .from('leave_requests')
    .select('*, applicant:profiles!leave_requests_applicant_id_fkey(id, chinese_name, full_name, email)')
    .order('created_at', { ascending: false })
    .limit(500)
  if (!canManage) query = query.eq('applicant_id', profile.id)
  const { data } = await query

  const requests = (data ?? []) as LeaveRequestWithProfile[]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">请假申请</h1>
        <p className="text-sm text-muted-foreground">
          员工提交请假申请，财务或管理员审批后自动写入对应月份的考勤表；被驳回的申请可重新提交新的申请。
        </p>
      </div>
      <LeaveManager requests={requests} myProfileId={profile.id} canManage={canManage} />
    </div>
  )
}
