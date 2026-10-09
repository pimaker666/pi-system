'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { saveProfilePermissionOverride } from '@/lib/actions/permissions'
import type { PermissionDataScope, ProfilePermissionOverride } from '@/types'

type PermissionItem = {
  path: string
  label: string
  description: string
}

type PermissionDecision = 'inherit' | 'allow' | 'deny'
type FieldDecision = 'inherit' | 'visible' | 'hidden'

const permissionGroups: { title: string; items: PermissionItem[] }[] = [
  {
    title: '订单管理',
    items: [
      { path: 'orders.view', label: '查看订单', description: '查看订单列表与详情' },
      { path: 'orders.create', label: '新建订单', description: '创建每日订单' },
      { path: 'orders.edit', label: '编辑订单', description: '修改已有订单信息' },
      { path: 'orders.void', label: '作废订单', description: '将订单标记为已作废' },
      { path: 'orders.approve', label: '审核订单', description: '处理订单审核操作' },
      { path: 'orders.ship', label: '登记发货', description: '创建和修改发货记录' },
      { path: 'orders.export', label: '导出订单', description: '导出订单台账与报表' },
      { path: 'orders.record_transfer', label: '登记订单转账', description: '登记收款和转账记录' },
    ],
  },
  {
    title: '财务与资料',
    items: [
      { path: 'finance.view', label: '查看财务', description: '查看财务台账与收款信息' },
      { path: 'finance.financial_number', label: '查看财务编号', description: '显示订单财务编号' },
      { path: 'finance.cost', label: '查看成本', description: '显示成本相关金额' },
      { path: 'finance.profit', label: '查看利润', description: '显示利润核算数据' },
      { path: 'finance.exchange_rate', label: '查看汇率', description: '显示订单和收款汇率' },
      { path: 'products.view', label: '查看产品', description: '浏览产品库和定制产品' },
      { path: 'products.edit', label: '维护产品', description: '新增、编辑产品资料' },
      { path: 'customers.view', label: '查看客户', description: '浏览客户资料与订单' },
      { path: 'customers.edit', label: '维护客户', description: '新增、编辑客户资料' },
      { path: 'pi.view', label: '查看 PI', description: '浏览 PI 与历史记录' },
      { path: 'pi.create', label: '新建 PI', description: '创建新的 PI' },
      { path: 'pi.edit', label: '编辑 PI', description: '修改 PI 内容' },
      { path: 'pi.void', label: '作废 PI', description: '将 PI 标记为已作废' },
    ],
  },
  {
    title: '系统管理',
    items: [
      { path: 'system.manage_users', label: '管理账号', description: '创建、启用和停用账号' },
      { path: 'system.manage_permissions', label: '管理权限', description: '配置角色、账号例外和审核规则' },
      { path: 'system.view_audit', label: '查看审计日志', description: '查看权限与订单操作记录' },
    ],
  },
]

const sensitiveFields: PermissionItem[] = [
  { path: 'financial_number', label: '财务编号', description: '订单财务编号' },
  { path: 'product_name', label: '产品名称', description: '产品与定制产品名称' },
  { path: 'cost', label: '成本', description: '产品与订单成本金额' },
  { path: 'profit', label: '毛利', description: '订单和产品利润金额' },
  { path: 'exchange_rate', label: '汇率', description: '订单和收款汇率' },
]

function updateList(items: string[], path: string, include: boolean) {
  const next = items.filter((item) => item !== path)
  return include ? [...next, path] : next
}

function permissionDecision(allowed: string[], denied: string[], path: string): PermissionDecision {
  if (denied.includes(path)) return 'deny'
  if (allowed.includes(path)) return 'allow'
  return 'inherit'
}

function PermissionSelect({ item, value, disabled, onChange }: {
  item: PermissionItem
  value: PermissionDecision
  disabled: boolean
  onChange: (value: PermissionDecision) => void
}) {
  return <div className="flex items-center justify-between gap-3 rounded-md border p-3">
    <div className="min-w-0"><p className="text-sm font-medium">{item.label}</p><p className="text-xs text-muted-foreground">{item.description}</p></div>
    <select aria-label={`${item.label}例外权限`} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as PermissionDecision)} className="h-8 shrink-0 rounded-md border bg-background px-2 text-xs">
      <option value="inherit">继承角色</option>
      <option value="allow">单独允许</option>
      <option value="deny">单独禁止</option>
    </select>
  </div>
}

function FieldSelect({ item, value, disabled, onChange }: {
  item: PermissionItem
  value: FieldDecision
  disabled: boolean
  onChange: (value: FieldDecision) => void
}) {
  return <div className="flex items-center justify-between gap-3 rounded-md border p-3">
    <div className="min-w-0"><p className="text-sm font-medium">{item.label}</p><p className="text-xs text-muted-foreground">{item.description}</p></div>
    <select aria-label={`${item.label}可见性`} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as FieldDecision)} className="h-8 shrink-0 rounded-md border bg-background px-2 text-xs">
      <option value="inherit">继承角色</option>
      <option value="visible">单独可见</option>
      <option value="hidden">单独隐藏</option>
    </select>
  </div>
}

export function AccountPermissionOverrideForm({ profileId, initial }: { profileId: string; initial: ProfilePermissionOverride | null }) {
  const [allowed, setAllowed] = useState(initial?.allowed_permissions ?? [])
  const [denied, setDenied] = useState(initial?.denied_permissions ?? [])
  const [scope, setScope] = useState<PermissionDataScope | ''>(initial?.data_scope ?? '')
  const [fields, setFields] = useState<Record<string, unknown>>(initial?.sensitive_fields ?? {})
  const [pending, startTransition] = useTransition()

  function setPermission(path: string, value: PermissionDecision) {
    setAllowed((current) => updateList(current, path, value === 'allow'))
    setDenied((current) => updateList(current, path, value === 'deny'))
  }

  function setField(path: string, value: FieldDecision) {
    setFields((current) => {
      const next = { ...current }
      if (value === 'inherit') delete next[path]
      else next[path] = value === 'visible'
      return next
    })
  }

  function save() {
    startTransition(async () => {
      const result = await saveProfilePermissionOverride({
        profile_id: profileId,
        allowed_permissions: allowed,
        denied_permissions: denied,
        data_scope: scope || null,
        sensitive_fields: fields,
        expires_at: null,
      })
      if (result.ok) toast.success('账号例外权限已保存')
      else toast.error(result.error ?? '保存失败')
    })
  }

  return <Card>
    <CardHeader><CardTitle>账号例外授权</CardTitle><CardDescription>账号例外优先于角色模板；“继承角色”表示不单独覆盖该项权限。</CardDescription></CardHeader>
    <CardContent className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        {permissionGroups.map((group) => <div key={group.title} className="space-y-2"><h3 className="text-sm font-semibold">{group.title}</h3><div className="space-y-2">{group.items.map((item) => <PermissionSelect key={item.path} item={item} value={permissionDecision(allowed, denied, item.path)} disabled={pending} onChange={(value) => setPermission(item.path, value)} />)}</div></div>)}
      </div>
      <div className="space-y-2"><h3 className="text-sm font-semibold">数据范围</h3><select aria-label="数据范围例外" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={scope} disabled={pending} onChange={(event) => setScope(event.target.value as PermissionDataScope | '')}><option value="">继承角色模板</option><option value="self">仅本人</option><option value="self_and_subordinates">本人及下级</option><option value="team">指定团队</option><option value="all">全部数据</option></select></div>
      <div className="space-y-2"><h3 className="text-sm font-semibold">敏感字段覆盖</h3><p className="text-sm text-muted-foreground">可为该账号单独显示或隐藏敏感字段。</p><div className="grid gap-2 md:grid-cols-2">{sensitiveFields.map((item) => <FieldSelect key={item.path} item={item} value={fields[item.path] === true ? 'visible' : fields[item.path] === false ? 'hidden' : 'inherit'} disabled={pending} onChange={(value) => setField(item.path, value)} />)}</div></div>
      <div className="sticky bottom-4 z-10 flex justify-end rounded-lg border bg-background/95 p-3 shadow-sm backdrop-blur"><Button disabled={pending} onClick={save}>{pending ? '保存中…' : '保存例外权限'}</Button></div>
    </CardContent>
  </Card>
}
