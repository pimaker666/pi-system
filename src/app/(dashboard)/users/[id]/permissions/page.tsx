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
  const [override, resolved] = await Promise.all([
    getProfilePermissionOverride(id),
    getResolvedProfilePermission(id),
  ])
  return <AccountPermissionDetail profile={data as Profile} override={override} resolved={resolved} />
}
