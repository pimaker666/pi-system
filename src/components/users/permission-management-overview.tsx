'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { savePermissionTemplate } from '@/lib/actions/permissions'
import { isEnabled, permissionGroups, sensitiveFields, setEnabled, type JsonObject, type PermissionItem } from '@/components/users/permission-catalog'
import type { PermissionDataScope, PermissionTemplate, UserRole } from '@/types'

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
