'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin, requireFinanceAccess } from '@/lib/auth'
import type { ActionResult } from './products'
import type { UserRole } from '@/types'

export interface HandoverSummary {
  customer_count: number
  business_order_count: number
  shop_assignment_count: number
  source_disabled: boolean
}

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

/** Promote or demote a user's role through the protected administrator RPC. */
export async function setUserRole(
  userId: string,
  role: UserRole,
): Promise<ActionResult> {
  const me = await requireAdmin()

  if (!(['admin', 'finance', 'sales', 'supervisor'] as const).includes(role)) {
    return { ok: false, error: '无效的用户角色' }
  }
  if (userId === me.id) return { ok: false, error: '不能修改自己的角色' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('admin_set_user_role', {
    p_user_id: userId,
    p_role: role,
  })
  if (error) {
    const message = error.message.includes('Disabled accounts')
      ? '停用账号需先恢复后才能修改角色'
      : error.message.includes('At least one approved administrator')
        ? '至少需保留一名已通过审核的管理员'
        : error.message.includes('Only approved administrators')
          ? '只有已通过审核的管理员可以修改角色'
          : error.message.includes('own role')
            ? '不能修改自己的角色'
            : error.message
    return { ok: false, error: message }
  }

  revalidatePath('/users')
  return { ok: true }
}

/** Set or clear a user's reporting manager through the protected administrator RPC. */
export async function setUserManager(
  userId: string,
  managerId: string | null,
): Promise<ActionResult> {
  await requireAdmin()

  const supabase = await createClient()
  const { error } = await supabase.rpc('set_user_manager', {
    p_user_id: userId,
    p_manager_id: managerId,
  })

  if (error) {
    const message = error.message.includes('User does not exist')
      ? '用户不存在'
      : error.message.includes('their own manager')
        ? '不能将用户设置为自己的上级'
        : error.message.includes('users can have a manager')
          ? '只有业务员、业务主管或管理员可以设置上级'
          : error.message.includes('approved supervisor or administrator')
            ? '上级必须是已通过审核的业务主管或管理员'
            : error.message.includes('cannot contain a cycle')
              ? '上级关系不能形成环'
              : error.message.includes('Disabled accounts')
                ? '停用账号需先恢复后才能修改上级'
                : error.message.includes('Only approved administrators')
                  ? '只有已通过审核的管理员可以设置上级'
                  : error.message.includes('Only administrators')
                    ? '只有管理员可以设置上级'
                    : error.message
    return { ok: false, error: message }
  }

  revalidatePath('/users')
  return { ok: true }
}

/** Approve a pending user so they can access the system. Admin-only. */
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

/** Reset a user's login password. Admin-only. */
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

/** Disable or restore an existing approved account without deleting its history. */
export async function setUserDisabled(
  userId: string,
  disabled: boolean,
  reason: string,
): Promise<ActionResult> {
  await requireAdmin()

  const normalizedReason = reason.trim()
  if (disabled && !normalizedReason) return { ok: false, error: '请填写停用原因' }
  if (normalizedReason.length > 1000) return { ok: false, error: '原因不能超过 1000 个字符' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('admin_set_user_disabled', {
    p_user_id: userId,
    p_disabled: disabled,
    p_reason: normalizedReason || null,
  })
  if (error) {
    const message = error.message.includes('own account')
      ? '不能停用自己的账号'
      : error.message.includes('At least one approved administrator')
        ? '至少需保留一名已通过审核的管理员'
        : error.message.includes('Only approved administrators') ||
            error.message.includes('Only administrators can change account status') ||
            error.message.includes('permission was revoked while waiting for the account lock')
          ? '只有已通过审核的管理员可以停用或恢复账号'
          : error.message.includes('Only approved accounts')
            ? '只有已通过审核的账号可以停用'
            : error.message.includes('Only disabled accounts')
              ? '只有已停用的账号可以恢复'
              : error.message
    return { ok: false, error: message }
  }

  revalidatePath('/users')
  return { ok: true }
}

/** Atomically transfer customers and open business orders, optionally disabling the source account. */
export async function handoverUser(input: {
  sourceUserId: string
  targetUserId: string
  transferCustomers: boolean
  transferOpenOrders: boolean
  disableSource: boolean
  reason: string
}): Promise<ActionResult & { summary?: HandoverSummary }> {
  await requireAdmin()

  if (!input.targetUserId) return { ok: false, error: '请选择接手账号' }
  if (input.sourceUserId === input.targetUserId) {
    return { ok: false, error: '接手账号不能与原账号相同' }
  }
  const reason = input.reason.trim()
  if (!reason) return { ok: false, error: '请填写交接原因' }
  if (reason.length > 1000) return { ok: false, error: '交接原因不能超过 1000 个字符' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_handover_user', {
    p_from_user_id: input.sourceUserId,
    p_to_user_id: input.targetUserId,
    p_customer_ids: input.transferCustomers ? null : [],
    p_transfer_open_orders: input.transferCustomers && input.transferOpenOrders,
    p_disable_source: input.disableSource,
    p_reason: reason,
  })
  if (error) {
    const message = error.message.includes('approved non-finance')
      ? '接手账号必须是已通过审核的非财务账号'
      : error.message.includes('own account')
        ? '不能在本次交接中停用自己的账号'
        : error.message.includes('At least one approved administrator')
          ? '至少需保留一名已通过审核的管理员'
          : error.message.includes('Only approved administrators') ||
              error.message.includes('Only administrators can hand over accounts') ||
              error.message.includes('permission was revoked while waiting for the handover lock')
            ? '只有已通过审核的管理员可以执行账号交接'
            : error.message
    return { ok: false, error: message }
  }

  revalidatePath('/users')
  revalidatePath('/customers')
  revalidatePath('/pi/history')
  revalidatePath('/finance')
  revalidatePath('/finance/daily-orders')
  revalidatePath('/finance/performance')
  return { ok: true, summary: data as unknown as HandoverSummary }
}

/** Permanently delete an unreferenced pending account. Admin-only. */
export async function deleteUser(userId: string): Promise<ActionResult> {
  const me = await requireAdmin()

  if (userId === me.id) {
    return { ok: false, error: '不能删除自己的账号' }
  }

  const supabase = await createClient()
  const { data: canDelete, error: eligibilityError } = await supabase.rpc(
    'admin_can_delete_pending_user',
    { p_user_id: userId },
  )
  if (eligibilityError) return { ok: false, error: eligibilityError.message }
  if (!canDelete) {
    return {
      ok: false,
      error: '只能永久删除从未产生任何业务引用的待审核误建账号；离职账号请使用停用或离职交接',
    }
  }

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
