import { createClient } from '@/lib/supabase/server'
import { hasCurrentPermission, requireAdmin, requireApproved } from '@/lib/auth'
import { displayProfileName, formatDate } from '@/lib/utils'
import type {
  ApprovalApprover,
  ApprovalInboxItem,
  ApprovalInboxScope,
  ApprovalRule,
  ApprovalSideTodo,
  UserRole,
} from '@/types'

export async function fetchApprovalInbox(scope: ApprovalInboxScope): Promise<ApprovalInboxItem[]> {
  await requireApproved()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('approval_inbox', { p_scope: scope })
  if (error) throw new Error(`读取审批列表失败：${error.message}`)
  return (data ?? []) as ApprovalInboxItem[]
}

export async function fetchReimbursementTodos(): Promise<ApprovalSideTodo[]> {
  await requireApproved()
  if (!(await hasCurrentPermission('reimbursement.review'))) return []
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('finance_reimbursement_requests')
    .select(
      'id, expense_date, project_name, applicant:profiles!finance_reimbursement_requests_applicant_id_fkey(chinese_name, full_name, email), items:finance_reimbursement_items(amount)',
    )
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(20)
  if (error || !data) return []
  return data.map((row) => {
    const record = row as {
      id: string
      expense_date: string
      project_name: string | null
      applicant?: { chinese_name?: string | null; full_name?: string | null; email?: string | null } | null
      items?: { amount?: number | string | null }[]
    }
    const total = (record.items ?? []).reduce(
      (sum, item) => sum + Number(item.amount ?? 0),
      0,
    )
    return {
      id: record.id,
      title: `${record.project_name ?? '费用报销'} · ${formatDate(record.expense_date)}`,
      detail: `${displayProfileName(record.applicant)} · ${record.items?.length ?? 0} 项 · ¥${total.toFixed(2)}`,
      href: '/reimbursement',
    }
  })
}

export async function fetchApprovalPendingCount(): Promise<number> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('approval_pending_count')
  if (error) return 0
  return (data as number | null) ?? 0
}

export async function fetchApprovalRules(): Promise<ApprovalRule[]> {
  await requireAdmin()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('approval_rules_for_admin')
  if (error) throw new Error(`读取审批规则失败：${error.message}`)
  return (data ?? []) as ApprovalRule[]
}

export async function fetchApprovalApprovers(): Promise<ApprovalApprover[]> {
  await requireAdmin()
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, chinese_name, email, role')
    .eq('status', 'approved')
    .order('role')
  if (error) throw new Error(`读取账号列表失败：${error.message}`)
  return (data ?? []).map((profile) => ({
    id: profile.id as string,
    name: displayProfileName(profile),
    role: profile.role as UserRole,
  }))
}
