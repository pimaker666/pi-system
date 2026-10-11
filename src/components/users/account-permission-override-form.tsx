'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { isEnabled, permissionGroups, sensitiveFields, type JsonObject, type PermissionItem } from '@/components/users/permission-catalog'
import { saveProfilePermissionOverride } from '@/lib/actions/permissions'
import type { PermissionDataScope, ProfilePermissionOverride } from '@/types'

type PermissionState = 'inherit' | 'allow' | 'deny'
type FieldState = 'inherit' | 'visible' | 'hidden'

const scopeOptions: { value: PermissionDataScope; label: string }[] = [
  { value: 'self', label: '仅本人' },
  { value: 'self_and_subordinates', label: '本人及下级' },
  { value: 'team', label: '指定团队' },
  { value: 'all', label: '全部数据' },
]

function TriState<T extends string>({ value, options, disabled, onChange }: {
  value: T
  options: { value: T; label: string; activeClass: string }[]
  disabled: boolean
  onChange: (value: T) => void
}) {
  return (
    <div className="inline-flex shrink-0 overflow-hidden rounded-md border">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`px-2.5 py-1 text-xs transition-colors disabled:opacity-60 ${
            value === option.value
              ? option.activeClass
              : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function OverrideRow({ item, hint, children }: {
  item: PermissionItem
  hint: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3">
      <span className="grid gap-0.5">
        <span className="text-sm font-medium">{item.label}</span>
        <span className="text-xs text-muted-foreground">{item.description} · 角色默认：{hint}</span>
      </span>
      {children}
    </div>
  )
}

export function AccountPermissionOverrideForm({
  profileId,
  initial,
  templatePermissions,
  templateFields,
}: {
  profileId: string
  initial: ProfilePermissionOverride | null
  templatePermissions: JsonObject
  templateFields: JsonObject
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [permissionState, setPermissionState] = useState<Record<string, PermissionState>>(() => {
    const state: Record<string, PermissionState> = {}
    for (const group of permissionGroups) {
      for (const item of group.items) {
        state[item.path] = initial?.denied_permissions.includes(item.path)
          ? 'deny'
          : initial?.allowed_permissions.includes(item.path)
            ? 'allow'
            : 'inherit'
      }
    }
    return state
  })
  const [fieldState, setFieldState] = useState<Record<string, FieldState>>(() => {
    const state: Record<string, FieldState> = {}
    for (const item of sensitiveFields) {
      state[item.path] = item.path in (initial?.sensitive_fields ?? {})
        ? (initial?.sensitive_fields[item.path] === true ? 'visible' : 'hidden')
        : 'inherit'
    }
    return state
  })
  const [scope, setScope] = useState<PermissionDataScope | ''>(initial?.data_scope ?? '')

  function save() {
    const allowed = Object.entries(permissionState).filter(([, value]) => value === 'allow').map(([path]) => path)
    const denied = Object.entries(permissionState).filter(([, value]) => value === 'deny').map(([path]) => path)
    const sensitive: JsonObject = {}
    for (const [path, value] of Object.entries(fieldState)) {
      if (value === 'visible') sensitive[path] = true
      if (value === 'hidden') sensitive[path] = false
    }
    startTransition(async () => {
      const result = await saveProfilePermissionOverride({
        profile_id: profileId,
        allowed_permissions: allowed,
        denied_permissions: denied,
        data_scope: scope || null,
        sensitive_fields: sensitive,
        expires_at: null,
      })
      if (result.ok) {
        toast.success('账号例外权限已保存')
        router.refresh()
      } else {
        toast.error(result.error ?? '保存失败')
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="font-medium">账号例外授权</p>
        <p className="text-sm text-muted-foreground">
          「继承」跟随角色模板；「允许」和「禁止」覆盖模板，禁止优先于允许。保存后立即生效并写入审计日志。
        </p>
      </div>

      {permissionGroups.map((group) => (
        <Card key={group.title}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{group.title}</CardTitle>
            <CardDescription>{group.description}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 md:grid-cols-2">
            {group.items.map((item) => (
              <OverrideRow key={item.path} item={item} hint={isEnabled(templatePermissions, item.path) ? '允许' : '不允许'}>
                <TriState
                  value={permissionState[item.path]}
                  disabled={pending}
                  onChange={(value) => setPermissionState((current) => ({ ...current, [item.path]: value }))}
                  options={[
                    { value: 'inherit' as const, label: '继承', activeClass: 'bg-muted text-foreground font-medium' },
                    { value: 'allow' as const, label: '允许', activeClass: 'bg-primary text-primary-foreground' },
                    { value: 'deny' as const, label: '禁止', activeClass: 'bg-destructive text-destructive-foreground' },
                  ]}
                />
              </OverrideRow>
            ))}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">敏感字段可见性</CardTitle>
          <CardDescription>覆盖该账号能看到哪些敏感字段；「继承」跟随角色模板。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2">
          {sensitiveFields.map((item) => (
            <OverrideRow key={item.path} item={item} hint={isEnabled(templateFields, item.path) ? '可见' : '隐藏'}>
              <TriState
                value={fieldState[item.path]}
                disabled={pending}
                onChange={(value) => setFieldState((current) => ({ ...current, [item.path]: value }))}
                options={[
                  { value: 'inherit' as const, label: '继承', activeClass: 'bg-muted text-foreground font-medium' },
                  { value: 'visible' as const, label: '可见', activeClass: 'bg-primary text-primary-foreground' },
                  { value: 'hidden' as const, label: '隐藏', activeClass: 'bg-destructive text-destructive-foreground' },
                ]}
              />
            </OverrideRow>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">数据范围</CardTitle>
          <CardDescription>「继承角色模板」时按角色模板的数据范围执行。</CardDescription>
        </CardHeader>
        <CardContent>
          <select
            className="h-9 w-full max-w-xs rounded-md border bg-background px-3 text-sm"
            value={scope}
            disabled={pending}
            onChange={(event) => setScope(event.target.value as PermissionDataScope | '')}
          >
            <option value="">继承角色模板</option>
            {scopeOptions.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </CardContent>
      </Card>

      <div className="sticky bottom-4 z-10 flex justify-end rounded-lg border bg-background/95 p-3 shadow-sm backdrop-blur">
        <Button disabled={pending} onClick={save}>{pending ? '保存中…' : '保存例外权限'}</Button>
      </div>
    </div>
  )
}
