import { cache } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import {
  FINANCE_PAGE_KEYS,
  FINANCE_PAGE_PERMISSION_LIST,
  type FinancePage,
  type FinancePageAccess,
} from '@/lib/finance-permissions'
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

/** 当前账号的财务页面访问权：逐个权限点解析角色模板与账号例外。同请求内只查一次。 */
export const getFinancePageAccess = cache(async (): Promise<FinancePageAccess> => {
  await requireApproved()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('current_permission_map', {
    p_permissions: [...FINANCE_PAGE_PERMISSION_LIST],
  })
  if (error) throw new Error(`读取财务页面权限失败：${error.message}`)
  const granted = (data ?? {}) as Record<string, boolean>
  return {
    overview: granted[FINANCE_PAGE_KEYS.overview] === true,
    journal: granted[FINANCE_PAGE_KEYS.journal] === true,
    costs: granted[FINANCE_PAGE_KEYS.costs] === true,
    settledOrders: granted[FINANCE_PAGE_KEYS.settledOrders] === true,
    profit: granted[FINANCE_PAGE_KEYS.profit] === true,
    commissionSettled: granted[FINANCE_PAGE_KEYS.commissionSettled] === true,
  }
})

/** 财务页面只读守卫：无该页面权限时退回业务业绩页；写操作仍走 requireFinanceAccess。 */
export async function requireFinancePage(page: FinancePage): Promise<Profile> {
  const profile = await requireApproved()
  const access = await getFinancePageAccess()
  if (!access[page]) {
    redirect('/finance/performance')
  }
  return profile
}

export const hasCurrentPermission = cache(async (permission: string): Promise<boolean> => {
  await requireApproved()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('has_current_permission', {
    p_permission: permission,
  })
  if (error) throw new Error(`读取账号权限失败：${error.message}`)
  return data === true
})

/** 当前账号的敏感字段可见性（角色模板按键合并账号例外）。同请求内只查一次。 */
export const getCurrentSensitiveFields = cache(
  async (): Promise<Record<string, boolean>> => {
    await requireApproved()
    const supabase = await createClient()
    const { data, error } = await supabase.rpc('current_sensitive_fields')
    if (error) throw new Error(`读取敏感字段权限失败：${error.message}`)
    return (data ?? {}) as Record<string, boolean>
  },
)

export async function canViewSensitiveField(field: string): Promise<boolean> {
  return (await getCurrentSensitiveFields())[field] === true
}
