import { z } from 'zod'

export const permissionDataScopes = ['self', 'self_and_subordinates', 'team', 'all'] as const
export const approvalTargets = ['business_order', 'daily_order'] as const
export const approvalTriggerActions = [
  'order_edit',
  'amount_or_rate_change',
  'shipment_change',
  'void_order',
  'commission_clearance_cancel',
  'item_settlement_cancel',
] as const
export const approvalModes = ['any', 'sequential'] as const
export const permissionAuditEntityTypes = ['permission_template', 'profile_permission_override', 'order_edit_approval_rule'] as const

const jsonObject = z.record(z.unknown()).default({})
const permissionPathList = z.array(z.string().trim().regex(/^[a-z_]+(?:\.[a-z_]+)*$/, '权限标识格式无效').max(120)).max(100).default([])

export const permissionTemplateSchema = z.object({
  system_role: z.enum(['admin', 'finance', 'sales', 'supervisor']),
  name: z.string().trim().min(1, '请输入模板名称').max(80),
  description: z.string().trim().max(500).default(''),
  permissions: jsonObject,
  data_scope: z.enum(permissionDataScopes),
  sensitive_fields: jsonObject,
}).strict()

export const profilePermissionOverrideSchema = z.object({
  profile_id: z.string().uuid('账号无效'),
  allowed_permissions: permissionPathList,
  denied_permissions: permissionPathList,
  data_scope: z.enum(permissionDataScopes).nullable().default(null),
  sensitive_fields: jsonObject,
  expires_at: z.string().datetime().nullable().default(null),
}).strict().superRefine((value, ctx) => {
  const allowed = new Set(value.allowed_permissions)
  for (const denied of value.denied_permissions) {
    if (allowed.has(denied)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['denied_permissions'], message: '同一权限不能同时授予和禁止' })
      break
    }
  }
  if (value.expires_at && new Date(value.expires_at).getTime() <= Date.now()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expires_at'], message: '有效期必须晚于当前时间' })
  }
})

export const orderEditApprovalRuleSchema = z.object({
  id: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1, '请输入规则名称').max(120),
  enabled: z.boolean(),
  target: z.enum(approvalTargets),
  trigger_actions: z.array(z.enum(approvalTriggerActions)).min(1, '请选择至少一项触发操作'),
  conditions: jsonObject,
  reviewer_roles: z.array(z.enum(['admin', 'finance', 'sales', 'supervisor'])).max(4).default([]),
  reviewer_ids: z.array(z.string().uuid()).max(100).default([]),
  approval_mode: z.enum(approvalModes),
}).strict().superRefine((value, ctx) => {
  if (value.enabled && value.reviewer_roles.length === 0 && value.reviewer_ids.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reviewer_roles'], message: '启用规则时必须指定至少一位审核人' })
  }
})

export type PermissionTemplateInput = z.infer<typeof permissionTemplateSchema>
export type ProfilePermissionOverrideInput = z.infer<typeof profilePermissionOverrideSchema>
export type OrderEditApprovalRuleInput = z.infer<typeof orderEditApprovalRuleSchema>
