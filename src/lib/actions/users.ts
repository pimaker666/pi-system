'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin, requireFinanceAccess } from '@/lib/auth'
import type { ActionResult } from './products'
import type { UserRole } from '@/types'

/** Update the separately managed Chinese name. Approved admin/finance only. */
export async function updateUserChineseName(
  userId: string,
  chineseName: string,
): Promise<ActionResult> {
  await requireFinanceAccess()

  const normalizedName = chineseName.trim()
  if (normalizedName.length > 50) {
    return { ok: false, error: '中文名不能超过 50 个字符' }
  }

  const supabase = await createClient()
  const { error } = await supabase.rpc('update_profile_chinese_name', {
    p_user_id: userId,
    p_chinese_name: normalizedName,
  })

  if (error) {
    const message = error.message.includes('User does not exist')
      ? '用户不存在'
      : error.message.includes('Chinese name cannot exceed 50 characters')
        ? '中文名不能超过 50 个字符'
        : error.message.includes('Only approved finance users or administrators')
          ? '只有已通过审核的财务或管理员可以修改中文名'
          : error.message
    return { ok: false, error: message }
  }

  revalidatePath('/users')
  return { ok: true }
}

/**
 * Promote or demote a user's role. Admin-only.
 * Guards:
 *  - cannot change your own role (avoid locking yourself out)
 *  - cannot demote the last remaining admin
 */
export async function setUserRole(
  userId: string,
  role: UserRole,
): Promise<ActionResult> {
  const me = await requireAdmin()

  if (!(['admin', 'finance', 'sales'] as const).includes(role)) {
    return { ok: false, error: '无效的用户角色' }
  }

  if (userId === me.id) {
    return { ok: false, error: '不能修改自己的角色' }
  }

  const supabase = await createClient()

  // When changing an admin to any non-admin role, ensure at least one admin remains.
  if (role !== 'admin') {
    const { data: target } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single()

    if (target?.role === 'admin') {
      const { count } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'admin')
      if ((count ?? 0) <= 1) {
        return { ok: false, error: '至少需保留一名管理员，无法取消' }
      }
    }
  }

  const { error } = await supabase
    .from('profiles')
    .update({ role })
    .eq('id', userId)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/users')
  return { ok: true }
}

/**
 * Approve a pending user so they can access the system. Admin-only.
 */
export async function approveUser(userId: string): Promise<ActionResult> {
  await requireAdmin()

  const supabase = await createClient()
  const { error } = await supabase
    .from('profiles')
    .update({ status: 'approved' })
    .eq('id', userId)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/users')
  return { ok: true }
}

/**
 * Reset (set) a user's login password. Admin-only.
 * Uses the service-role admin client to overwrite the password directly, so the
 * admin can help any user (including pending ones) regain access.
 */
export async function resetUserPassword(
  userId: string,
  formData: FormData,
): Promise<ActionResult> {
  await requireAdmin()

  const password = String(formData.get('password') ?? '')
  if (password.length < 6) {
    return { ok: false, error: '密码至少需要 6 位' }
  }

  const admin = createAdminClient()
  try {
    const { error } = await admin.auth.admin.updateUserById(userId, { password })
    if (error) {
      console.error('[resetUserPassword] admin API returned error:', error)
      const detail = error.message || JSON.stringify(error)
      return { ok: false, error: `重置失败：${detail || '未知错误'}` }
    }
  } catch (e) {
    console.error('[resetUserPassword] threw:', e)
    const detail =
      e instanceof Error
        ? `${e.name}: ${e.message}`
        : typeof e === 'string'
          ? e
          : JSON.stringify(e, Object.getOwnPropertyNames(e ?? {}))
    return { ok: false, error: `重置异常：${detail || '未知错误'}` }
  }

  revalidatePath('/users')
  return { ok: true }
}

/**
 * Permanently delete a registered user. Admin-only.
 * Removes the auth account; the profiles row is removed automatically via the
 * `on delete cascade` foreign key. Requires the service-role admin client.
 * Guards:
 *  - cannot delete your own account
 *  - cannot delete the last remaining admin
 */
export async function deleteUser(userId: string): Promise<ActionResult> {
  const me = await requireAdmin()

  if (userId === me.id) {
    return { ok: false, error: '不能删除自己的账号' }
  }

  const supabase = await createClient()

  // If the target is an admin, ensure at least one admin remains afterwards.
  const { data: target } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single()
  if (target?.role === 'admin') {
    const { count } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
    if ((count ?? 0) <= 1) {
      return { ok: false, error: '至少需保留一名管理员，无法删除' }
    }
  }

  // Deleting the auth user cascades to the profiles row (FK on delete cascade).
  const admin = createAdminClient()
  try {
    const { error } = await admin.auth.admin.deleteUser(userId)
    if (error) {
      console.error('[deleteUser] admin API returned error:', error)
      const detail =
        error.message ||
        (typeof (error as { status?: number }).status !== 'undefined'
          ? `HTTP ${(error as { status?: number }).status}`
          : '') ||
        JSON.stringify(error)
      return { ok: false, error: `删除失败：${detail || '未知错误'}` }
    }
  } catch (e) {
    // A thrown error (network / fetch / non-2xx without JSON) lands here.
    console.error('[deleteUser] threw:', e)
    const detail =
      e instanceof Error
        ? `${e.name}: ${e.message}`
        : typeof e === 'string'
          ? e
          : JSON.stringify(e, Object.getOwnPropertyNames(e ?? {}))
    return { ok: false, error: `删除异常：${detail || '未知错误'}` }
  }

  revalidatePath('/users')
  return { ok: true }
}
