'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { saveOrderEditApprovalRule } from '@/lib/actions/permissions'
import type { OrderEditApprovalRule, OrderEditApprovalTrigger, UserRole } from '@/types'

type ApprovalFlowDefinition = {
  key: string
  title: string
  description: string
  defaultName: string
  triggerActions: OrderEditApprovalTrigger[]
}

const roleLabels: { value: UserRole; label: string }[] = [
  { value: 'admin', label: '管理员' },
  { value: 'finance', label: '财务' },
  { value: 'supervisor', label: '业务主管' },
  { value: 'sales', label: '业务员' },
]

const approvalFlows: ApprovalFlowDefinition[] = [
  {
    key: 'order_edit',
    title: '订单编辑审核',
    description: '订单编辑、金额或汇率修改、发货信息修改时的审核规则。',
    defaultName: '订单编辑审核',
    triggerActions: ['order_edit', 'amount_or_rate_change', 'shipment_change'],
  },
  {
    key: 'commission_clearance_cancel',
    title: '已结清订单取消结清审核',
    description: '取消已确认的产品行提成结清前使用的审核规则。',
    defaultName: '已结清订单取消结清审核',
    triggerActions: ['commission_clearance_cancel'],
  },
  {
    key: 'item_settlement_cancel',
    title: '已结算订单取消结算审核',
    description: '取消已结算产品行成本结算前使用的审核规则。',
    defaultName: '已结算订单取消结算审核',
    triggerActions: ['item_settlement_cancel'],
  },
]

function ApprovalFlowCard({ definition, initial }: { definition: ApprovalFlowDefinition; initial: OrderEditApprovalRule | undefined }) {
  const [name, setName] = useState(initial?.name ?? definition.defaultName)
  const [enabled, setEnabled] = useState(initial?.enabled ?? false)
  const [reviewers, setReviewers] = useState<UserRole[]>(initial?.reviewer_roles ?? ['admin', 'finance'])
  const [mode, setMode] = useState<'any' | 'sequential'>(initial?.approval_mode ?? 'any')
  const [pending, startTransition] = useTransition()

  function toggle(role: UserRole) {
    setReviewers((current) => current.includes(role) ? current.filter((item) => item !== role) : [...current, role])
  }

  function save() {
    startTransition(async () => {
      const result = await saveOrderEditApprovalRule({
        id: initial?.id ?? null,
        name,
        enabled,
        target: 'business_order',
        trigger_actions: definition.triggerActions,
        conditions: {},
        reviewer_roles: reviewers,
        reviewer_ids: [],
        approval_mode: mode,
      })
      if (result.ok) toast.success(`${definition.title}已保存`)
      else toast.error(result.error ?? '保存失败')
    })
  }

  return <Card>
    <CardHeader>
      <CardTitle>{definition.title}</CardTitle>
      <CardDescription>{definition.description}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-5">
      <div>
        <label className="text-sm font-medium" htmlFor={`${definition.key}-name`}>规则名称</label>
        <Input id={`${definition.key}-name`} value={name} disabled={pending} onChange={(event) => setName(event.target.value)} />
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} disabled={pending} onChange={(event) => setEnabled(event.target.checked)} />启用{definition.title}</label>
      <div>
        <p className="text-sm font-medium">审核角色</p>
        <div className="mt-2 flex flex-wrap gap-3">{roleLabels.map((role) => <label key={role.value} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reviewers.includes(role.value)} disabled={pending} onChange={() => toggle(role.value)} />{role.label}</label>)}</div>
      </div>
      <div>
        <p className="text-sm font-medium">通过方式</p>
        <div className="mt-2 flex gap-4 text-sm"><label><input type="radio" checked={mode === 'any'} disabled={pending} onChange={() => setMode('any')} /> 任一审核人通过</label><label><input type="radio" checked={mode === 'sequential'} disabled={pending} onChange={() => setMode('sequential')} /> 逐级审核</label></div>
      </div>
      <div className="flex justify-end"><Button disabled={pending || !name.trim() || (enabled && reviewers.length === 0)} onClick={save}>{pending ? '保存中…' : enabled ? '保存并启用' : '保存规则'}</Button></div>
    </CardContent>
  </Card>
}

export function ApprovalFlowOverview({ rules }: { rules: OrderEditApprovalRule[] }) {
  return <div className="space-y-6">
    <Card className="border-primary/30 bg-primary/5"><CardContent className="p-4 text-sm text-muted-foreground">审批规则会保存至权限审计日志。当前版本先持久化审核配置，取消结清和取消结算的实际拦截将在后续版本化 RPC 中接入。</CardContent></Card>
    <div className="grid gap-6 xl:grid-cols-2">{approvalFlows.map((definition) => {
      const initial = rules.find((rule) => rule.trigger_actions.includes(definition.triggerActions[0]))
      return <ApprovalFlowCard key={`${definition.key}-${initial?.id ?? 'new'}`} definition={definition} initial={initial} />
    })}</div>
  </div>
}
