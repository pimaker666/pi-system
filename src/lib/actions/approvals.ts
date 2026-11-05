'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin, requireApproved } from '@/lib/auth'
import type { ActionResult } from './products'
import type { ApprovalActionKey, UserRole } from '@/types'

const decideSchema = z
  .object({
    request_id: z.string().uuid('审批请求无效'),
    decision: z.enum(['approve', 'reject']),
    note: z.string().trim().max(1000, '审批说明不能超过 1000 字').optional().default(''),
  })
  .superRefine((value, ctx) => {
    if (value.decision === 'reject' && !value.note) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: '驳回时必须填写原因',
      })
    }
  })

const saveRuleSchema = z
  .object({
    action_key: z.enum([
      'business_order.review',
      'order_edit',
      'item_adjust',
      'void_order',
      'cost_override',
    ]),
    name: z.string().trim().min(1, '请输入规则名称').max(80, '规则名称最多 80 字'),
    enabled: z.boolean(),
    amount_gte: z.number().min(0, '金额阈值不能为负').nullable(),
    approver_roles: z.array(z.enum(['admin', 'finance', 'supervisor', 'sales'])).max(4),
    approver_ids: z.array(z.string().uuid()).max(100),
    mode: z.enum(['any', 'sequential']),
    allow_self_approval: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.enabled && value.approver_roles.length === 0 && value.approver_ids.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approver_roles'],
        message: '启用规则时必须指定至少一位审核人',
      })
    }
  })

function refreshApprovalPaths() {
  revalidatePath('/approvals')
  revalidatePath('/users/approval-flow')
  revalidatePath('/finance/daily-orders')
  revalidatePath('/finance/costs')
  revalidatePath('/finance/settled-orders')
}

export async function decideApproval(input: {
  request_id: string
  decision: 'approve' | 'reject'
  note?: string
}): Promise<ActionResult & { status?: string }> {
  await requireApproved()
  const parsed = decideSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? '审批内容无效' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('approval_decide', {
    p_request_id: parsed.data.request_id,
    p_decision: parsed.data.decision,
    p_note: parsed.data.note || null,
  })
  if (error) return { ok: false, error: error.message }

  const result = (data ?? {}) as { status?: string; error?: string }
  refreshApprovalPaths()
  if (result.status === 'apply_failed') {
    return {
      ok: false,
      status: 'apply_failed',
      error: `审批已通过，但自动执行失败：${result.error ?? '未知错误'}`,
    }
  }
  return { ok: true, status: result.status }
}

export async function cancelApproval(requestId: string): Promise<ActionResult> {
  await requireApproved()
  const id = z.string().uuid().safeParse(requestId)
  if (!id.success) return { ok: false, error: '审批请求无效' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('approval_cancel', { p_request_id: id.data })
  if (error) return { ok: false, error: error.message }
  refreshApprovalPaths()
  return { ok: true }
}

export async function retryApproval(requestId: string): Promise<ActionResult & { status?: string }> {
  await requireApproved()
  const id = z.string().uuid().safeParse(requestId)
  if (!id.success) return { ok: false, error: '审批请求无效' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('approval_retry', { p_request_id: id.data })
  if (error) return { ok: false, error: error.message }

  const result = (data ?? {}) as { status?: string; error?: string }
  refreshApprovalPaths()
  if (result.status === 'apply_failed') {
    return { ok: false, status: 'apply_failed', error: `重试失败：${result.error ?? '未知错误'}` }
  }
  return { ok: true, status: result.status }
}

export async function saveApprovalRule(input: {
  action_key: ApprovalActionKey
  name: string
  enabled: boolean
  amount_gte: number | null
  approver_roles: UserRole[]
  approver_ids: string[]
  mode: 'any' | 'sequential'
  allow_self_approval: boolean
}): Promise<ActionResult> {
  await requireAdmin()
  const parsed = saveRuleSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? '审批规则无效' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('admin_save_approval_rule', {
    p_action_key: parsed.data.action_key,
    p_name: parsed.data.name,
    p_enabled: parsed.data.enabled,
    p_conditions: parsed.data.amount_gte === null ? {} : { amount_gte: parsed.data.amount_gte },
    p_approver_roles: parsed.data.approver_roles,
    p_approver_ids: parsed.data.approver_ids,
    p_mode: parsed.data.mode,
    p_allow_self_approval: parsed.data.allow_self_approval,
  })
  if (error) return { ok: false, error: error.message }
  refreshApprovalPaths()
  return { ok: true }
}
