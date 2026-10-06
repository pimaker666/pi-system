'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { saveProfilePermissionOverride } from '@/lib/actions/permissions'
import type { PermissionDataScope, ProfilePermissionOverride } from '@/types'

function paths(value: string) { return value.split(',').map((item) => item.trim()).filter(Boolean) }

export function AccountPermissionOverrideForm({ profileId, initial }: { profileId: string; initial: ProfilePermissionOverride | null }) {
  const [allowed, setAllowed] = useState(initial?.allowed_permissions.join(', ') ?? '')
  const [denied, setDenied] = useState(initial?.denied_permissions.join(', ') ?? '')
  const [scope, setScope] = useState<PermissionDataScope | ''>(initial?.data_scope ?? '')
  const [fields, setFields] = useState(JSON.stringify(initial?.sensitive_fields ?? {}, null, 2))
  const [pending, startTransition] = useTransition()
  function save() {
    let sensitiveFields: Record<string, unknown>
    try { sensitiveFields = JSON.parse(fields) } catch { toast.error('敏感字段配置必须是有效 JSON 对象'); return }
    startTransition(async () => {
      const result = await saveProfilePermissionOverride({ profile_id: profileId, allowed_permissions: paths(allowed), denied_permissions: paths(denied), data_scope: scope || null, sensitive_fields: sensitiveFields, expires_at: null })
      if (result.ok) toast.success('账号例外权限已保存'); else toast.error(result.error ?? '保存失败')
    })
  }
  return <div className="space-y-4 rounded-md border p-4"><div><p className="font-medium">账号例外授权</p><p className="text-sm text-muted-foreground">使用“模块.操作”格式，例如 orders.record_transfer；禁止权限优先于角色模板。</p></div><div className="grid gap-4 md:grid-cols-2"><div><label className="text-sm font-medium">单独授予</label><Input value={allowed} disabled={pending} placeholder="orders.record_transfer" onChange={(e) => setAllowed(e.target.value)} /></div><div><label className="text-sm font-medium">单独禁止</label><Input value={denied} disabled={pending} placeholder="orders.void" onChange={(e) => setDenied(e.target.value)} /></div></div><div><label className="text-sm font-medium">数据范围</label><select className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm" value={scope} disabled={pending} onChange={(e) => setScope(e.target.value as PermissionDataScope | '')}><option value="">继承角色模板</option><option value="self">仅本人</option><option value="self_and_subordinates">本人及下级</option><option value="team">指定团队</option><option value="all">全部数据</option></select></div><div><label className="text-sm font-medium">敏感字段覆盖（JSON）</label><Textarea className="mt-1 font-mono text-xs" value={fields} disabled={pending} onChange={(e) => setFields(e.target.value)} /></div><div className="flex justify-end"><Button disabled={pending} onClick={save}>{pending ? '保存中…' : '保存例外权限'}</Button></div></div>
}
