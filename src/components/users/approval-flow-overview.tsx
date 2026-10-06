'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { saveOrderEditApprovalRule } from '@/lib/actions/permissions'
import type { OrderEditApprovalRule, UserRole } from '@/types'

const roleLabels: { value: UserRole; label: string }[] = [{ value: 'admin', label: '管理员' }, { value: 'finance', label: '财务' }, { value: 'supervisor', label: '业务主管' }, { value: 'sales', label: '业务员' }]
export function ApprovalFlowOverview({ rules }: { rules: OrderEditApprovalRule[] }) {
  const initial = rules[0]
  const [name, setName] = useState(initial?.name ?? '订单编辑审核')
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [reviewers, setReviewers] = useState<UserRole[]>(initial?.reviewer_roles ?? ['admin'])
  const [mode, setMode] = useState<'any' | 'sequential'>(initial?.approval_mode ?? 'any')
  const [pending, startTransition] = useTransition()
  function toggle(role: UserRole) { setReviewers((current) => current.includes(role) ? current.filter((item) => item !== role) : [...current, role]) }
  function save() { startTransition(async () => { const result = await saveOrderEditApprovalRule({ id: initial?.id ?? null, name, enabled, target: 'business_order', trigger_actions: ['order_edit', 'amount_or_rate_change', 'shipment_change'], conditions: {}, reviewer_roles: reviewers, reviewer_ids: [], approval_mode: mode }); if (result.ok) toast.success('审批规则已保存'); else toast.error(result.error ?? '保存失败') }) }
  return <div className="space-y-6"><Card><CardHeader><CardTitle>订单编辑审核规则</CardTitle><CardDescription>保存配置后将记录在权限审计日志中。当前规则先作为配置持久化，订单写入拦截将在版本化 RPC 中单独接入。</CardDescription></CardHeader><CardContent className="space-y-5"><div><label className="text-sm font-medium">规则名称</label><Input value={name} disabled={pending} onChange={(e) => setName(e.target.value)} /></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} disabled={pending} onChange={(e) => setEnabled(e.target.checked)} />启用订单编辑审核</label><div><p className="text-sm font-medium">审核角色</p><div className="mt-2 flex flex-wrap gap-3">{roleLabels.map((role) => <label key={role.value} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reviewers.includes(role.value)} disabled={pending} onChange={() => toggle(role.value)} />{role.label}</label>)}</div></div><div><p className="text-sm font-medium">通过方式</p><div className="mt-2 flex gap-4 text-sm"><label><input type="radio" checked={mode === 'any'} onChange={() => setMode('any')} /> 任一审核人通过</label><label><input type="radio" checked={mode === 'sequential'} onChange={() => setMode('sequential')} /> 逐级审核</label></div></div><div className="flex justify-end"><Button disabled={pending || !name.trim()} onClick={save}>{pending ? '保存中…' : '保存并启用'}</Button></div></CardContent></Card></div>
}
