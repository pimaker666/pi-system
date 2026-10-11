import { cache } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import type { Profile } from '@/types'

/** Current authenticated user's profile, or null. Deduped per request. */
export const getCurrentProfile = cache(async (): Promise<Profile | null> => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  return (data as Profile) ?? null
})

/** Require a logged-in user, else redirect to login. */
export async function requireProfile(): Promise<Profile> {
  const profile = await getCurrentProfile()
  if (!profile) redirect('/login')
  return profile
}

/**
 * Require a logged-in AND admin-approved user.
 * Un-approved (pending) users are sent to the waiting-for-approval screen.
 */
export async function requireApproved(): Promise<Profile> {
  const profile = await requireProfile()
  if (profile.status !== 'approved') redirect('/pending')
  return profile
}

/** Require an admin, else redirect to dashboard. */
export async function requireAdmin(): Promise<Profile> {
  const profile = await requireApproved()
  if (profile.role !== 'admin') redirect('/dashboard')
  return profile
}

/** Require an approved admin or finance user. */
export async function requireFinanceAccess(): Promise<Profile> {
  const profile = await requireApproved()
  if (profile.role !== 'admin' && profile.role !== 'finance') {
    redirect('/finance/performance')
  }
  return profile
}

/** 财务查看准入：admin/finance 角色，或被授予 finance.view 权限的账号。 */
export async function hasFinanceViewFor(profile: Profile): Promise<boolean> {
  if (profile.role === 'admin' || profile.role === 'finance') return true
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('has_current_permission', {
    p_permission: 'finance.view',
  })
  if (error) throw new Error(`读取账号权限失败：${error.message}`)
  return data === true
}

/** 财务页面只读守卫：角色或 finance.view 例外放行；写操作仍走 requireFinanceAccess。 */
export async function requireFinanceView(): Promise<Profile> {
  const profile = await requireApproved()
  if (!(await hasFinanceViewFor(profile))) {
    redirect('/finance/performance')
  }
  return profile
}

export async function hasCurrentPermission(permission: string): Promise<boolean> {
  const profile = await requireApproved()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('has_current_permission', {
    p_permission: permission,
  })
  if (error) throw new Error(`读取账号权限失败：${error.message}`)
  return data === true
}
