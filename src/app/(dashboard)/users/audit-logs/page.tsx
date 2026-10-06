import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PermissionPageNav } from '@/components/users/permission-page-nav'
import { requireFinanceAccess } from '@/lib/auth'
import { getPermissionAuditLogs } from '@/lib/actions/permissions'
import { createClient } from '@/lib/supabase/server'
import { formatDate, displayProfileName } from '@/lib/utils'
import type { PermissionAuditLog, Profile } from '@/types'

type OrderAuditLog = {
  id: string
  order_id: string
  action: string
  reason: string | null
  actor_display_name_snapshot: string | null
  created_at: string
  actor: Pick<Profile, 'id' | 'email' | 'full_name' | 'chinese_name'> | null
}

type UnifiedAuditLog = {
  id: string
  source: 'order' | 'permission'
  subject: string
  action: string
  actor: string
  detail: string
  created_at: string
  orderId?: string
}

const actionLabels: Record<string, string> = {
  create: '创建',
  update: '修改',
  submit: '提交审核',
  approve: '审核通过',
  reject: '驳回订单',
  payment_add: '新增收款',
  payment_update: '修改收款',
  payment_void: '作废收款',
  finance_update: '更新财务核算',
  complete: '完成订单',
  correct: '修正订单',
}

const permissionSubjectLabels: Record<PermissionAuditLog['entity_type'], string> = {
  permission_template: '角色权限模板',
  profile_permission_override: '账号例外权限',
  order_edit_approval_rule: '订单编辑审批规则',
}

function orderActorName(log: OrderAuditLog) {
  return log.actor_display_name_snapshot || (log.actor ? displayProfileName(log.actor as Profile) : null) || '系统'
}

function permissionActorName(log: PermissionAuditLog) {
  const snapshot = log.actor_snapshot
  return typeof snapshot.full_name === 'string' && snapshot.full_name.trim()
    ? snapshot.full_name
    : typeof snapshot.email === 'string' && snapshot.email.trim()
      ? snapshot.email
      : '系统'
}

export default async function AuditLogsPage() {
  const currentProfile = await requireFinanceAccess()
  const supabase = await createClient()
  const { data } = await supabase
    .from('business_order_audit_logs')
    .select('id, order_id, action, reason, actor_display_name_snapshot, created_at, actor:profiles!actor_id(id, email, full_name, chinese_name)')
    .order('created_at', { ascending: false })
    .limit(100)
  const orderLogs = (data ?? []) as unknown as OrderAuditLog[]
  const permissionLogs = currentProfile.role === 'admin' ? await getPermissionAuditLogs() : []
  const logs: UnifiedAuditLog[] = [
    ...orderLogs.map((log) => ({
      id: `order-${log.id}`,
      source: 'order' as const,
      subject: '订单',
      action: actionLabels[log.action] ?? log.action,
      actor: orderActorName(log),
      detail: log.reason ?? '—',
      created_at: log.created_at,
      orderId: log.order_id,
    })),
    ...permissionLogs.map((log) => ({
      id: `permission-${log.id}`,
      source: 'permission' as const,
      subject: permissionSubjectLabels[log.entity_type],
      action: actionLabels[log.action] ?? log.action,
      actor: permissionActorName(log),
      detail: `记录 ID：${log.entity_id}`,
      created_at: log.created_at,
    })),
  ].sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()).slice(0, 100)
  const today = new Date().toDateString()
  const todayCount = logs.filter((log) => new Date(log.created_at).toDateString() === today).length
  const approvalCount = orderLogs.filter((log) => log.action === 'approve' || log.action === 'reject').length

  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-semibold">审批记录与审计日志</h1><p className="text-sm text-muted-foreground">追溯客户订单审批、修改和财务操作；管理员还可查看权限配置变更。</p></div>
      <PermissionPageNav active="/users/audit-logs" showConfiguration={currentProfile.role === 'admin'} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">最近 100 条记录</p><p className="mt-1 text-2xl font-semibold">{logs.length}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">今日操作</p><p className="mt-1 text-2xl font-semibold">{todayCount}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">审批决定</p><p className="mt-1 text-2xl font-semibold">{approvalCount}</p></CardContent></Card>
      </div>
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-3 md:flex-row"><Input placeholder="搜索功能将在后续版本提供" disabled /><p className="shrink-0 text-sm text-muted-foreground md:self-center">当前展示最近 100 条已记录操作</p></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-sm"><thead className="border-b text-left text-muted-foreground"><tr><th className="px-3 py-3 font-medium">业务对象</th><th className="px-3 py-3 font-medium">操作</th><th className="px-3 py-3 font-medium">操作人</th><th className="px-3 py-3 font-medium">说明</th><th className="px-3 py-3 font-medium">时间</th><th className="px-3 py-3 text-right font-medium">详情</th></tr></thead><tbody>{logs.map((log) => <tr key={log.id} className="border-b last:border-0"><td className="px-3 py-3 font-medium">{log.subject}</td><td className="px-3 py-3"><Badge variant={log.source === 'permission' ? 'outline' : log.action === '驳回订单' ? 'destructive' : log.action === '审核通过' ? 'outline' : 'secondary'}>{log.action}</Badge></td><td className="px-3 py-3">{log.actor}</td><td className="max-w-64 truncate px-3 py-3 text-muted-foreground">{log.detail}</td><td className="px-3 py-3 text-muted-foreground">{formatDate(log.created_at)}</td><td className="px-3 py-3 text-right">{log.orderId ? <Link className="text-primary hover:underline" href={`/finance/daily-orders/${log.orderId}`}>查看订单</Link> : '—'}</td></tr>)}{logs.length === 0 && <tr><td colSpan={6} className="py-12 text-center text-muted-foreground">暂无可查看的审计记录</td></tr>}</tbody></table></div>
        </CardContent>
      </Card>
    </div>
  )
}
