import { notFound } from 'next/navigation'
import { AccountPermissionDetail } from '@/components/users/account-permission-detail'
import { requireAdmin } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { getProfilePermissionOverride, getResolvedProfilePermission } from '@/lib/actions/permissions'
import type { Profile } from '@/types'

export default async function AccountPermissionsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin()
  const { id } = await params
  const supabase = await createClient()
  const { data, error } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle()
  if (error || !data) notFound()
  const [override, resolved, templateResult] = await Promise.all([
    getProfilePermissionOverride(id),
    getResolvedProfilePermission(id),
    supabase
      .from('permission_templates')
      .select('permissions, sensitive_fields')
      .eq('system_role', (data as Profile).role)
      .maybeSingle(),
  ])
  if (templateResult.error) throw new Error(`读取角色权限模板失败：${templateResult.error.message}`)
  return (
    <AccountPermissionDetail
      profile={data as Profile}
      override={override}
      resolved={resolved}
      templatePermissions={(templateResult.data?.permissions ?? {}) as Record<string, unknown>}
      templateSensitiveFields={(templateResult.data?.sensitive_fields ?? {}) as Record<string, unknown>}
    />
  )
}
