'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { saveApprovalRule } from '@/lib/actions/approvals'
import { cn } from '@/lib/utils'
import type {
  ApprovalActionKey,
  ApprovalApprover,
  ApprovalMode,
  ApprovalRule,
  UserRole,
} from '@/types'

const ROLE_LABELS: Record<UserRole, string> = {
  admin: '管理员',
  finance: '财务',
  supervisor: '业务主管',
  sales: '业务员',
}

const ACTION_META: { key: ApprovalActionKey; label: string; description: string }[] = [
  {
    key: 'business_order.review',
    label: '订单审核',
    description: '业务员提交订单后，需要指定审核人审核通过才会进入已审核状态。',
  },
  {
    key: 'order_edit',
    label: '订单编辑',
    description: '修改已审核订单的表头或产品明细时触发审批。',
  },
  {
    key: 'item_adjust',
    label: '订单加单/改行',
    description: '追加产品、修改或删除订单产品行时触发审批。',
  },
  {
    key: 'void_order',
    label: '订单作废',
    description: '作废业务订单时触发审批，通过后订单才会作废。',
  },
  {
    key: 'cost_override',
    label: '成本覆盖',
    description: '财务手工修改已发货订单行的成本时触发审批。',
  },
]

const DEFAULT_ROLES: Record<ApprovalActionKey, UserRole[]> = {
  'business_order.review': ['admin'],
  order_edit: ['admin'],
  item_adjust: ['admin'],
  void_order: ['admin', 'finance'],
  cost_override: ['admin'],
}

interface RuleDraft {
  name: string
  enabled: boolean
  amountGte: string
  roles: UserRole[]
  ids: string[]
  mode: ApprovalMode
  allowSelf: boolean
}

function toDraft(actionKey: ApprovalActionKey, rule: ApprovalRule | undefined): RuleDraft {
  const meta = ACTION_META.find((entry) => entry.key === actionKey)
  const rawAmount = rule?.conditions?.amount_gte
  const amountGte =
    actionKey === 'business_order.review'
      ? ''
      : typeof rawAmount === 'number' || typeof rawAmount === 'string'
        ? String(rawAmount)
        : ''
  return {
    name: rule?.name ?? meta?.label ?? actionKey,
    enabled: rule?.enabled ?? false,
    amountGte,
    roles: rule ? (rule.approver_roles ?? []) : DEFAULT_ROLES[actionKey],
    ids: rule?.approver_ids ?? [],
    mode: rule?.mode ?? 'any',
    allowSelf: rule?.allow_self_approval ?? false,
  }
}

const fieldLabel = 'text-sm font-medium'

export function ApprovalRuleSettings({
  rules,
  approvers,
}: {
  rules: ApprovalRule[]
  approvers: ApprovalApprover[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [drafts, setDrafts] = useState<Record<ApprovalActionKey, RuleDraft>>(() => {
    const byKey = new Map(rules.map((rule) => [rule.action_key, rule]))
    return Object.fromEntries(
      ACTION_META.map((meta) => [meta.key, toDraft(meta.key, byKey.get(meta.key))]),
    ) as Record<ApprovalActionKey, RuleDraft>
  })

  function update(actionKey: ApprovalActionKey, patch: Partial<RuleDraft>) {
    setDrafts((current) => ({ ...current, [actionKey]: { ...current[actionKey], ...patch } }))
  }

  function toggleIn<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
  }

  function save(actionKey: ApprovalActionKey) {
    const draft = drafts[actionKey]
    const normalized = draft.amountGte.trim()
    const amountGte = normalized === '' ? null : Number(normalized)
    if (amountGte !== null && (!Number.isFinite(amountGte) || amountGte < 0)) {
      toast.error('金额阈值必须是不小于 0 的数字')
      return
    }
    startTransition(async () => {
      const result = await saveApprovalRule({
        action_key: actionKey,
        name: draft.name,
        enabled: draft.enabled,
        amount_gte: amountGte,
        approver_roles: draft.roles,
        approver_ids: draft.ids,
        mode: draft.mode,
        allow_self_approval: draft.allowSelf,
      })
      if (!result.ok) {
        toast.error(result.error ?? '保存失败')
        return
      }
      toast.success('审批规则已保存')
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
        <p>规则即时生效：启用后才能拦截对应动作；关闭后该动作直接执行。</p>
        <p className="mt-1">
          角色与指定账号为并集，命中任一即可审核；逐级审核会按角色、再按指定账号依次流转。
        </p>
        <p className="mt-1">
          上线默认与当前口径一致：订单审核仅管理员，其余规则关闭；单人团队中如自己是唯一审核人，系统允许自审以免卡死。
        </p>
        <p className="mt-1">关闭订单审核后，业务员提交订单将直接通过审核，不再进入待审核状态。</p>
      </div>

      {ACTION_META.map((meta) => {
        const draft = drafts[meta.key]
        const rule = rules.find((entry) => entry.action_key === meta.key)
        const selectedApprovers = approvers.filter(
          (approver) => draft.roles.includes(approver.role) || draft.ids.includes(approver.id),
        )
        return (
          <Card key={meta.key}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">{meta.label}</CardTitle>
                  <CardDescription>{meta.description}</CardDescription>
                </div>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    disabled={pending}
                    onChange={(event) => update(meta.key, { enabled: event.target.checked })}
                  />
                  {draft.enabled ? '已启用' : '已关闭'}
                </label>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                className={cn(
                  'grid gap-4',
                  meta.key === 'business_order.review' ? '' : 'md:grid-cols-2',
                )}
              >
                <div className="space-y-1">
                  <label className={fieldLabel}>规则名称</label>
                  <Input
                    value={draft.name}
                    disabled={pending}
                    maxLength={80}
                    onChange={(event) => update(meta.key, { name: event.target.value })}
                  />
                </div>
                {meta.key !== 'business_order.review' && (
                  <div className="space-y-1">
                    <label className={fieldLabel}>金额阈值（订单总金额 ≥）</label>
                    <Input
                      value={draft.amountGte}
                      type="number"
                      min={0}
                      step="0.01"
                      disabled={pending}
                      placeholder="留空表示不限金额"
                      onChange={(event) => update(meta.key, { amountGte: event.target.value })}
                    />
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <p className={fieldLabel}>审核角色</p>
                <div className="flex flex-wrap gap-4">
                  {(Object.keys(ROLE_LABELS) as UserRole[]).map((role) => (
                    <label key={role} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.roles.includes(role)}
                        disabled={pending}
                        onChange={() => update(meta.key, { roles: toggleIn(draft.roles, role) })}
                      />
                      {ROLE_LABELS[role]}
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <p className={fieldLabel}>指定审核账号（可与角色同时使用）</p>
                <div className="max-h-40 overflow-y-auto rounded-md border p-2">
                  {approvers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">暂无已通过审核的账号</p>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {approvers.map((approver) => (
                        <label key={approver.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={draft.ids.includes(approver.id)}
                            disabled={pending}
                            onChange={() =>
                              update(meta.key, { ids: toggleIn(draft.ids, approver.id) })
                            }
                          />
                          <span className="truncate">{approver.name}</span>
                          <Badge variant="muted" className="shrink-0">
                            {ROLE_LABELS[approver.role] ?? approver.role}
                          </Badge>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-6">
                <div className="space-y-2">
                  <p className={fieldLabel}>通过方式</p>
                  <div className="flex flex-wrap gap-4 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`mode-${meta.key}`}
                        checked={draft.mode === 'any'}
                        disabled={pending}
                        onChange={() => update(meta.key, { mode: 'any' })}
                      />
                      任一审核人通过
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`mode-${meta.key}`}
                        checked={draft.mode === 'sequential'}
                        disabled={pending}
                        onChange={() => update(meta.key, { mode: 'sequential' })}
                      />
                      逐级审核
                    </label>
                  </div>
                </div>
                <label className="flex items-center gap-2 self-end text-sm">
                  <input
                    type="checkbox"
                    checked={draft.allowSelf}
                    disabled={pending}
                    onChange={(event) => update(meta.key, { allowSelf: event.target.checked })}
                  />
                  允许发起人自审
                </label>
              </div>

              <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                当前生效审核人：
                {selectedApprovers.length > 0
                  ? selectedApprovers.map((approver) => approver.name).join('、')
                  : '未指定'}
                {rule?.updated_at ? ` · 最近保存 ${rule.updated_at.slice(0, 10)}` : ''}
              </div>

              <div className="flex justify-end">
                <Button disabled={pending || !draft.name.trim()} onClick={() => save(meta.key)}>
                  {pending ? '保存中…' : '保存规则'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
