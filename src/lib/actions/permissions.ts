'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth'
import type { ActionResult } from './products'
import {
  orderEditApprovalRuleSchema,
  permissionTemplateSchema,
  profilePermissionOverrideSchema,
  type OrderEditApprovalRuleInput,
  type PermissionTemplateInput,
  type ProfilePermissionOverrideInput,
} from '@/schemas/permission'
import type {
  OrderEditApprovalRule,
  PermissionAuditLog,
  PermissionTemplate,
  ProfilePermissionOverride,
  ResolvedProfilePermission,
} from '@/types'

function permissionError(message: string, fallback: string) {
  if (message.includes('Only approved administrators')) return '只有已通过审核的管理员可以配置权限'
  if (message.includes('Profile does not exist')) return '账号不存在'
  if (message.includes('Enabled rule requires')) return '启用规则时必须指定至少一位审核人'
  if (message.includes('Reviewers must be approved')) return '审核人必须是已通过审核的账号'
  return message || fallback
}

function invalidatePermissionPaths(profileId?: string) {
  revalidatePath('/users')
  revalidatePath('/users/permissions')
  revalidatePath('/users/approval-flow')
  revalidatePath('/users/audit-logs')
  if (profileId) revalidatePath(`/users/${profileId}/permissions`)
}

export async function getPermissionTemplates(): Promise<PermissionTemplate[]> {
  await requireAdmin()
  const supabase = await createClient()
  const { data, error } = await supabase.from('permission_templates').select('*').order('system_role')
  if (error) throw new Error(`读取权限模板失败：${error.message}`)
  return (data ?? []) as PermissionTemplate[]
}

export async function getOrderEditApprovalRules(): Promise<OrderEditApprovalRule[]> {
  await requireAdmin()
  const supabase = await createClient()
  const { data, error } = await supabase.from('order_edit_approval_rules').select('*').order('updated_at', { ascending: false })
  if (error) throw new Error(`读取审批规则失败：${error.message}`)
  return (data ?? []) as OrderEditApprovalRule[]
}

export async function getProfilePermissionOverride(profileId: string): Promise<ProfilePermissionOverride | null> {
  await requireAdmin()
  const supabase = await createClient()
  const { data, error } = await supabase.from('profile_permission_overrides').select('*').eq('profile_id', profileId).maybeSingle()
  if (error) throw new Error(`读取账号例外权限失败：${error.message}`)
  return data as ProfilePermissionOverride | null
}

export async function getResolvedProfilePermission(profileId: string): Promise<ResolvedProfilePermission> {
  await requireAdmin()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('get_profile_permission_resolution', { p_profile_id: profileId })
  if (error || !data) throw new Error(`读取账号权限失败：${error?.message ?? '数据不存在'}`)
  return data as ResolvedProfilePermission
}

export async function getPermissionAuditLogs(): Promise<PermissionAuditLog[]> {
  await requireAdmin()
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('permission_audit_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw new Error(`读取权限审计日志失败：${error.message}`)
  return (data ?? []) as PermissionAuditLog[]
}

export async function savePermissionTemplate(input: PermissionTemplateInput): Promise<ActionResult> {
  await requireAdmin()
  const parsed = permissionTemplateSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? '权限模板无效' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('admin_save_permission_template', {
    p_system_role: parsed.data.system_role,
    p_name: parsed.data.name,
    p_description: parsed.data.description,
    p_permissions: parsed.data.permissions,
    p_data_scope: parsed.data.data_scope,
    p_sensitive_fields: parsed.data.sensitive_fields,
  })
  if (error) return { ok: false, error: permissionError(error.message, '保存权限模板失败') }
  invalidatePermissionPaths()
  return { ok: true }
}

export async function saveProfilePermissionOverride(input: ProfilePermissionOverrideInput): Promise<ActionResult> {
  await requireAdmin()
  const parsed = profilePermissionOverrideSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? '账号例外权限无效' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('admin_save_profile_permission_override', {
    p_profile_id: parsed.data.profile_id,
    p_allowed_permissions: parsed.data.allowed_permissions,
    p_denied_permissions: parsed.data.denied_permissions,
    p_data_scope: parsed.data.data_scope,
    p_sensitive_fields: parsed.data.sensitive_fields,
    p_expires_at: parsed.data.expires_at,
  })
  if (error) return { ok: false, error: permissionError(error.message, '保存账号例外权限失败') }
  invalidatePermissionPaths(parsed.data.profile_id)
  return { ok: true }
}

export async function saveOrderEditApprovalRule(input: OrderEditApprovalRuleInput): Promise<ActionResult> {
  await requireAdmin()
  const parsed = orderEditApprovalRuleSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? '审批规则无效' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('admin_save_order_edit_approval_rule', {
    p_id: parsed.data.id,
    p_name: parsed.data.name,
    p_enabled: parsed.data.enabled,
    p_target: parsed.data.target,
    p_trigger_actions: parsed.data.trigger_actions,
    p_conditions: parsed.data.conditions,
    p_reviewer_roles: parsed.data.reviewer_roles,
    p_reviewer_ids: parsed.data.reviewer_ids,
    p_approval_mode: parsed.data.approval_mode,
  })
  if (error) return { ok: false, error: permissionError(error.message, '保存审批规则失败') }
  invalidatePermissionPaths()
  return { ok: true }
}
