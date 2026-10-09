'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { savePermissionTemplate } from '@/lib/actions/permissions'
import type { PermissionDataScope, PermissionTemplate, UserRole } from '@/types'

type JsonObject = Record<string, unknown>

type PermissionItem = {
  path: string
  label: string
  description: string
}

const roles: { value: UserRole; label: string }[] = [
  { value: 'admin', label: '管理员' },
  { value: 'finance', label: '财务' },
  { value: 'supervisor', label: '业务主管' },
  { value: 'sales', label: '业务员' },
]

const scopes: { value: PermissionDataScope; label: string }[] = [
  { value: 'self', label: '仅本人' },
  { value: 'self_and_subordinates', label: '本人及下级' },
  { value: 'team', label: '指定团队' },
  { value: 'all', label: '全部数据' },
]

const permissionGroups: { title: string; description: string; items: PermissionItem[] }[] = [
  {
    title: '订单管理',
    description: '每日订单的查看、建单、发货和作废权限。',
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
    description: '财务数据、产品、客户与 PI 的日常维护权限。',
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
    description: '账号、权限和审计记录的管理权限。',
    items: [
      { path: 'system.manage_users', label: '管理账号', description: '创建、启用和停用账号' },
      { path: 'system.manage_permissions', label: '管理权限', description: '配置角色、账号例外和审核规则' },
      { path: 'system.view_audit', label: '查看审计日志', description: '查看权限与订单操作记录' },
    ],
  },
]

const sensitiveFields: PermissionItem[] = [
  { path: 'cost', label: '成本', description: '产品与订单成本金额' },
  { path: 'profit', label: '利润', description: '订单和产品利润金额' },
  { path: 'product_name', label: '产品名称', description: '产品与定制产品名称' },
  { path: 'exchange_rate', label: '汇率', description: '订单和收款汇率' },
  { path: 'financial_number', label: '财务编号', description: '订单财务编号' },
]

function isEnabled(source: JsonObject, path: string) {
  return path.split('.').reduce<unknown>((value, key) => (
    value && typeof value === 'object' ? (value as JsonObject)[key] : undefined
  ), source) === true
}

function setEnabled(source: JsonObject, path: string, enabled: boolean): JsonObject {
  const result = structuredClone(source)
  const keys = path.split('.')
  let current = result
  for (const key of keys.slice(0, -1)) {
    const value = current[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) current[key] = {}
    current = current[key] as JsonObject
  }
  current[keys[keys.length - 1]] = enabled
  return result
}

function PermissionToggle({ item, checked, disabled, onChange }: {
  item: PermissionItem
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors hover:bg-muted/50">
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
    />
    <span className="grid gap-0.5"><span className="text-sm font-medium">{item.label}</span><span className="text-xs text-muted-foreground">{item.description}</span></span>
  </label>
}

export function PermissionManagementOverview({ templates }: { templates: PermissionTemplate[] }) {
  const [role, setRole] = useState<UserRole>('sales')
  const template = useMemo(() => templates.find((item) => item.system_role === role), [templates, role])
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState<PermissionDataScope>('self')
  const [permissions, setPermissions] = useState<JsonObject>({})
  const [fields, setFields] = useState<JsonObject>({})
  const selected = template ?? null

  useEffect(() => {
    setName(selected?.name ?? '')
    setDescription(selected?.description ?? '')
    setScope(selected?.data_scope ?? 'self')
    setPermissions(selected?.permissions ?? {})
    setFields(selected?.sensitive_fields ?? {})
  }, [selected])

  function setPermission(path: string, enabled: boolean) {
    setPermissions((current) => setEnabled(current, path, enabled))
  }

  function setField(path: string, enabled: boolean) {
    setFields((current) => setEnabled(current, path, enabled))
  }

  function setGroup(items: PermissionItem[], enabled: boolean) {
    setPermissions((current) => items.reduce((next, item) => setEnabled(next, item.path, enabled), current))
  }

  function save() {
    startTransition(async () => {
      const result = await savePermissionTemplate({
        system_role: role,
        name,
        description,
        permissions,
        data_scope: scope,
        sensitive_fields: fields,
      })
      if (result.ok) toast.success('角色权限模板已保存')
      else toast.error(result.error ?? '保存失败')
    })
  }

  return <div className="grid gap-6 xl:grid-cols-[220px_1fr]">
    <Card className="h-fit xl:sticky xl:top-6">
      <CardHeader><CardTitle className="text-base">角色模板</CardTitle><CardDescription>选择要配置的角色。</CardDescription></CardHeader>
      <CardContent className="space-y-1">{roles.map((item) => <Button key={item.value} type="button" variant={role === item.value ? 'default' : 'ghost'} className="w-full justify-start" onClick={() => setRole(item.value)}>{item.label}</Button>)}</CardContent>
    </Card>
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>角色权限配置</CardTitle><CardDescription>保存后会立即成为该系统角色的基准权限，并写入审计日志。</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div><label className="text-sm font-medium" htmlFor="template-name">模板名称</label><Input id="template-name" value={name} disabled={pending} onChange={(event) => setName(event.target.value)} /></div>
            <div><label className="text-sm font-medium" htmlFor="data-scope">数据范围</label><select id="data-scope" className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm" value={scope} disabled={pending} onChange={(event) => setScope(event.target.value as PermissionDataScope)}>{scopes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
          </div>
          <div><label className="text-sm font-medium" htmlFor="template-description">说明</label><Input id="template-description" value={description} disabled={pending} onChange={(event) => setDescription(event.target.value)} /></div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {permissionGroups.map((group) => {
          const enabledCount = group.items.filter((item) => isEnabled(permissions, item.path)).length
          return <Card key={group.title}>
            <CardHeader className="space-y-2 pb-3">
              <div className="flex items-start justify-between gap-3"><div><CardTitle className="text-base">{group.title}</CardTitle><CardDescription className="mt-1">{group.description}</CardDescription></div><span className="shrink-0 text-xs text-muted-foreground">{enabledCount}/{group.items.length} 已开启</span></div>
              <div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setGroup(group.items, true)}>全部开启</Button><Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setGroup(group.items, false)}>全部关闭</Button></div>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">{group.items.map((item) => <PermissionToggle key={item.path} item={item} checked={isEnabled(permissions, item.path)} disabled={pending} onChange={(enabled) => setPermission(item.path, enabled)} />)}</CardContent>
          </Card>
        })}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">敏感字段可见性</CardTitle><CardDescription>关闭后，该角色不能查看相应字段内容。</CardDescription></CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{sensitiveFields.map((item) => <PermissionToggle key={item.path} item={item} checked={isEnabled(fields, item.path)} disabled={pending} onChange={(enabled) => setField(item.path, enabled)} />)}</CardContent>
      </Card>

      <div className="sticky bottom-4 z-10 flex justify-end rounded-lg border bg-background/95 p-3 shadow-sm backdrop-blur"><Button disabled={pending || !name.trim()} onClick={save}>{pending ? '保存中…' : `保存${roles.find((item) => item.value === role)?.label ?? ''}权限`}</Button></div>
    </div>
  </div>
}
