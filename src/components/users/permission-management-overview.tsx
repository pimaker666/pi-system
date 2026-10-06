'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { savePermissionTemplate } from '@/lib/actions/permissions'
import type { PermissionDataScope, PermissionTemplate, UserRole } from '@/types'

const roles: { value: UserRole; label: string }[] = [
  { value: 'admin', label: '管理员' }, { value: 'finance', label: '财务' },
  { value: 'supervisor', label: '业务主管' }, { value: 'sales', label: '业务员' },
]
const scopes: { value: PermissionDataScope; label: string }[] = [
  { value: 'self', label: '仅本人' }, { value: 'self_and_subordinates', label: '本人及下级' },
  { value: 'team', label: '指定团队' }, { value: 'all', label: '全部数据' },
]

export function PermissionManagementOverview({ templates }: { templates: PermissionTemplate[] }) {
  const [role, setRole] = useState<UserRole>('sales')
  const template = useMemo(() => templates.find((item) => item.system_role === role), [templates, role])
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState<PermissionDataScope>('self')
  const [permissions, setPermissions] = useState('{}')
  const [fields, setFields] = useState('{}')
  const selected = template ?? null
  const sync = (next: PermissionTemplate | null) => {
    setName(next?.name ?? '')
    setDescription(next?.description ?? '')
    setScope(next?.data_scope ?? 'self')
    setPermissions(JSON.stringify(next?.permissions ?? {}, null, 2))
    setFields(JSON.stringify(next?.sensitive_fields ?? {}, null, 2))
  }
  useEffect(() => { sync(selected) }, [selected])
  function choose(next: UserRole) { setRole(next) }
  function save() {
    let permissionJson: Record<string, unknown>; let fieldJson: Record<string, unknown>
    try { permissionJson = JSON.parse(permissions); fieldJson = JSON.parse(fields) } catch { toast.error('权限配置和敏感字段必须是有效 JSON 对象'); return }
    startTransition(async () => {
      const result = await savePermissionTemplate({ system_role: role, name, description, permissions: permissionJson, data_scope: scope, sensitive_fields: fieldJson })
      if (result.ok) toast.success('角色权限模板已保存'); else toast.error(result.error ?? '保存失败')
    })
  }
  return <div className="grid gap-6 xl:grid-cols-[220px_1fr]">
    <Card className="h-fit"><CardHeader><CardTitle className="text-base">角色模板</CardTitle></CardHeader><CardContent className="space-y-1">{roles.map((item) => <Button key={item.value} type="button" variant={role === item.value ? 'default' : 'ghost'} className="w-full justify-start" onClick={() => choose(item.value)}>{item.label}</Button>)}</CardContent></Card>
    <div className="space-y-6"><Card><CardHeader><CardTitle>角色权限配置</CardTitle><CardDescription>保存后会立即成为该系统角色的基准权限，并写入审计日志。</CardDescription></CardHeader><CardContent className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2"><div><label className="text-sm font-medium">模板名称</label><Input value={name} disabled={pending} onChange={(e) => setName(e.target.value)} /></div><div><label className="text-sm font-medium">数据范围</label><select className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm" value={scope} disabled={pending} onChange={(e) => setScope(e.target.value as PermissionDataScope)}>{scopes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div></div>
      <div><label className="text-sm font-medium">说明</label><Input value={description} disabled={pending} onChange={(e) => setDescription(e.target.value)} /></div>
      <div><label className="text-sm font-medium">权限矩阵（JSON）</label><Textarea className="mt-1 min-h-64 font-mono text-xs" value={permissions} disabled={pending} onChange={(e) => setPermissions(e.target.value)} /></div>
      <div><label className="text-sm font-medium">敏感字段可见性（JSON）</label><Textarea className="mt-1 min-h-32 font-mono text-xs" value={fields} disabled={pending} onChange={(e) => setFields(e.target.value)} /></div>
      <div className="flex justify-end"><Button disabled={pending || !name.trim()} onClick={save}>{pending ? '保存中…' : '保存更改'}</Button></div>
    </CardContent></Card></div>
  </div>
}
