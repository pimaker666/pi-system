'use server'

// 请假审批动作。校验 schema 为本文件私有。批准后联动考勤：按请假区间把符号写入
// 考勤表（空白格才写，不覆盖财务已标记内容；缺考勤表时自动创建）。

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireApproved } from '@/lib/auth'
import { daysBetweenInclusive } from '@/lib/leave'
import type { ActionResult } from './products'
import type { LeaveDayPart, LeaveType } from '@/types'

const createSchema = z.object({
  leave_type: z.enum(['personal', 'sick', 'vacation']),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式不合法'),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式不合法'),
  day_part: z.enum(['full', 'morning', 'afternoon']),
  reason: z.string().trim().min(1, '请填写请假事由').max(500, '事由最长 500 字'),
})

const updateSchema = createSchema.extend({
  request_id: z.string().uuid(),
})

const requestIdSchema = z.object({
  request_id: z.string().uuid(),
})

const reviewSchema = z.object({
  request_id: z.string().uuid(),
  approve: z.boolean(),
  reject_reason: z.string().trim().max(500, '驳回原因最长 500 字').nullable().optional(),
})

export interface ReviewLeaveResult extends ActionResult {
  written_days?: number
  skipped_cells?: number
  created_sheets?: number
}

function revalidateLeave() {
  revalidatePath('/finance/leave')
  revalidatePath('/finance/attendance')
}

async function requireFinanceManager() {
  const profile = await requireApproved()
  if (profile.role !== 'admin' && profile.role !== 'finance') {
    throw new Error('仅财务或管理员可操作')
  }
  return profile
}

function validateRange(startDate: string, endDate: string) {
  if (endDate < startDate) return '结束日期不能早于开始日期'
  const days = daysBetweenInclusive(startDate, endDate)
  if (days.length > 62) return '单次请假不能超过 62 天'
  return null
}

export async function createLeaveRequest(input: {
  leave_type: LeaveType
  start_date: string
  end_date: string
  day_part: LeaveDayPart
  reason: string
}): Promise<ActionResult> {
  const profile = await requireApproved()
  const parsed = createSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const rangeError = validateRange(parsed.data.start_date, parsed.data.end_date)
  if (rangeError) return { ok: false, error: rangeError }

  const supabase = await createClient()
  const { error } = await supabase.from('leave_requests').insert({
    applicant_id: profile.id,
    leave_type: parsed.data.leave_type,
    start_date: parsed.data.start_date,
    end_date: parsed.data.end_date,
    day_part: parsed.data.day_part,
    reason: parsed.data.reason,
  })
  if (error) return { ok: false, error: `提交失败：${error.message}` }
  revalidateLeave()
  return { ok: true }
}

export async function updateLeaveRequest(input: {
  request_id: string
  leave_type: LeaveType
  start_date: string
  end_date: string
  day_part: LeaveDayPart
  reason: string
}): Promise<ActionResult> {
  await requireApproved()
  const parsed = updateSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const rangeError = validateRange(parsed.data.start_date, parsed.data.end_date)
  if (rangeError) return { ok: false, error: rangeError }

  const supabase = await createClient()
  const { request_id, ...fields } = parsed.data
  const { error } = await supabase
    .from('leave_requests')
    .update(fields)
    .eq('id', request_id)
    .eq('status', 'pending')
  if (error) return { ok: false, error: `保存失败：${error.message}` }
  revalidateLeave()
  return { ok: true }
}

export async function withdrawLeaveRequest(input: {
  request_id: string
}): Promise<ActionResult> {
  await requireApproved()
  const parsed = requestIdSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: '参数不合法' }
  const supabase = await createClient()
  const { error } = await supabase
    .from('leave_requests')
    .delete()
    .eq('id', parsed.data.request_id)
  if (error) return { ok: false, error: `撤回失败：${error.message}` }
  revalidateLeave()
  return { ok: true }
}

export async function reviewLeaveRequest(input: {
  request_id: string
  approve: boolean
  reject_reason?: string | null
}): Promise<ReviewLeaveResult> {
  await requireFinanceManager()
  const parsed = reviewSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  if (!parsed.data.approve) {
    const reason = parsed.data.reject_reason?.trim()
    if (!reason) return { ok: false, error: '驳回必须填写原因' }
  }

  // 审批与考勤联动在同一个数据库事务内完成（见 0136 迁移）
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('review_leave_request', {
    p_request_id: parsed.data.request_id,
    p_approve: parsed.data.approve,
    p_reject_reason: parsed.data.approve
      ? null
      : (parsed.data.reject_reason?.trim() ?? null),
  })
  if (error) return { ok: false, error: `审批失败：${error.message}` }

  const summary = (data ?? {}) as {
    written_days?: number
    skipped_cells?: number
    created_sheets?: number
  }
  revalidateLeave()
  return {
    ok: true,
    written_days: summary.written_days ?? 0,
    skipped_cells: summary.skipped_cells ?? 0,
    created_sheets: summary.created_sheets ?? 0,
  }
}
