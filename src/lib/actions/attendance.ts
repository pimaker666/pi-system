'use server'

// 考勤表动作。校验 schema 为本文件私有；维护入口仅财务/管理员（触发器同名校验）。

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireApproved, hasCurrentPermission } from '@/lib/auth'
import { ATTENDANCE_SYMBOL_SET } from '@/lib/attendance'
import { isValidHourlyLeave } from '@/lib/leave'
import type { ActionResult } from './products'

const monthSchema = z.string().regex(/^\d{4}-\d{2}-01$/, '月份格式须为 yyyy-mm')

const symbolOrEmpty = z.string().refine((value) => ATTENDANCE_SYMBOL_SET.includes(value) || value === '', {
  message: '考勤符号不合法',
})

const createSheetSchema = z.object({
  month: monthSchema,
  note: z.string().trim().max(500, '备注最长 500 字').nullable().optional(),
})

const sheetIdSchema = z.object({
  sheet_id: z.string().uuid(),
})

const addMemberSchema = z.object({
  sheet_id: z.string().uuid(),
  profile_id: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1, '姓名不能为空').max(50, '姓名最长 50 字').optional(),
})

const memberIdSchema = z.object({
  member_id: z.string().uuid(),
})

const leaveTypeSchema = z.enum(['personal', 'sick', 'vacation']).nullable().optional()
const leaveHoursSchema = z
  .number({ invalid_type_error: '小时数须为数字' })
  .min(0, '小时数不能为负')
  .max(3.5, '小时数超出范围')
  .nullable()
  .optional()

// 小时假挂在 √ 出勤格上：0.5 小时步进，上午最多 3h、下午最多 3.5h。
const attendanceCellFields = z.object({
  member_id: z.string().uuid(),
  day: z.coerce.number().int('日期须为整数').min(1, '日期不合法').max(31, '日期不合法'),
  morning: symbolOrEmpty,
  afternoon: symbolOrEmpty,
  morning_leave_hours: leaveHoursSchema,
  afternoon_leave_hours: leaveHoursSchema,
  morning_leave_type: leaveTypeSchema,
  afternoon_leave_type: leaveTypeSchema,
})

type AttendanceCellInput = z.infer<typeof attendanceCellFields>

function refineHourlyLeave(value: AttendanceCellInput, ctx: z.RefinementCtx) {
  for (const half of ['morning', 'afternoon'] as const) {
    const hours = Number(value[`${half}_leave_hours`] ?? 0)
    const type = value[`${half}_leave_type`] ?? null
    if (hours === 0) {
      if (type) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [`${half}_leave_type`],
          message: '小时数为 0 时不能指定请假类型',
        })
      }
      continue
    }
    if (value[half] !== '√') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [`${half}_leave_hours`],
        message: '小时假必须记录在 √ 出勤格上',
      })
      continue
    }
    if (!type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [`${half}_leave_type`],
        message: '请选择小时假类型',
      })
    }
    if (!isValidHourlyLeave(hours, half)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [`${half}_leave_hours`],
        message: '小时假须为 0.5 小时步进，上午不超过 3 小时、下午不超过 3.5 小时',
      })
    }
  }
}

const attendanceCellSchema = attendanceCellFields.superRefine(refineHourlyLeave)

const upsertEntrySchema = attendanceCellFields
  .extend({ sheet_id: z.string().uuid() })
  .superRefine(refineHourlyLeave)

const batchUpsertSchema = z.object({
  sheet_id: z.string().uuid(),
  items: z.array(attendanceCellSchema).min(1, '没有需要保存的考勤格').max(31 * 200, '单次批量范围过大'),
})

// 清除符号时一并把小时假归零，避免残留小时数挡住删除
function normalizeCell<T extends {
  morning: string
  afternoon: string
  morning_leave_hours?: number | null
  afternoon_leave_hours?: number | null
  morning_leave_type?: 'personal' | 'sick' | 'vacation' | null
  afternoon_leave_type?: 'personal' | 'sick' | 'vacation' | null
}>(item: T) {
  return {
    ...item,
    morning_leave_hours: item.morning === '√' ? (item.morning_leave_hours ?? 0) : 0,
    afternoon_leave_hours: item.afternoon === '√' ? (item.afternoon_leave_hours ?? 0) : 0,
    morning_leave_type: item.morning === '√' ? (item.morning_leave_type ?? null) : null,
    afternoon_leave_type: item.afternoon === '√' ? (item.afternoon_leave_type ?? null) : null,
  }
}

const updateNoteSchema = z.object({
  sheet_id: z.string().uuid(),
  note: z.string().trim().max(500, '备注最长 500 字').nullable(),
})

function revalidateAttendance() {
  revalidatePath('/finance/attendance')
}

async function requireFinanceManager() {
  const profile = await requireApproved()
  if (!(await hasCurrentPermission('attendance.manage'))) {
    throw new Error('当前账号没有考勤工资管理权限')
  }
  return profile
}

export async function createAttendanceSheet(input: {
  month: string
  note?: string | null
}): Promise<ActionResult & { sheet_id?: string }> {
  const profile = await requireFinanceManager()
  const parsed = createSheetSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const supabase = await createClient()
  const { data: sheet, error } = await supabase
    .from('attendance_sheets')
    .insert({
      month: parsed.data.month,
      note: parsed.data.note ?? null,
      created_by: profile.id,
    })
    .select('id')
    .single()
  if (error || !sheet) {
    if (error?.code === '23505') return { ok: false, error: '该月份考勤表已存在' }
    return { ok: false, error: `创建考勤表失败：${error?.message ?? '未知错误'}` }
  }
  revalidateAttendance()
  return { ok: true, sheet_id: sheet.id }
}

export async function updateAttendanceSheetNote(input: {
  sheet_id: string
  note: string | null
}): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = updateNoteSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const supabase = await createClient()
  const { error } = await supabase
    .from('attendance_sheets')
    .update({ note: parsed.data.note && parsed.data.note.trim() ? parsed.data.note.trim() : null })
    .eq('id', parsed.data.sheet_id)
  if (error) return { ok: false, error: `保存失败：${error.message}` }
  revalidateAttendance()
  return { ok: true }
}

export async function deleteAttendanceSheet(input: { sheet_id: string }): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = sheetIdSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: '参数不合法' }
  const supabase = await createClient()
  const { error } = await supabase.from('attendance_sheets').delete().eq('id', parsed.data.sheet_id)
  if (error) return { ok: false, error: `删除失败：${error.message}` }
  revalidateAttendance()
  return { ok: true }
}

// 添加成员：传 profile_id 则从系统账号取姓名快照；否则用手动姓名（无账号人员）。
export async function addAttendanceMember(input: {
  sheet_id: string
  profile_id?: string | null
  name?: string
}): Promise<ActionResult & { member_id?: string }> {
  await requireFinanceManager()
  const parsed = addMemberSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const { sheet_id, profile_id, name } = parsed.data
  const supabase = await createClient()

  let finalName = name?.trim() ?? ''
  let sortOrder = 0
  if (profile_id) {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, chinese_name, full_name, created_at')
      .eq('id', profile_id)
      .single()
    if (profileError || !profile) return { ok: false, error: '未找到该账号' }
    finalName = profile.chinese_name?.trim() || profile.full_name?.trim() || '成员'
    const { data: existing } = await supabase
      .from('attendance_members')
      .select('id')
      .eq('sheet_id', sheet_id)
      .eq('profile_id', profile_id)
      .maybeSingle()
    if (existing) return { ok: false, error: '该账号已在本考勤表中' }
  } else if (!finalName) {
    return { ok: false, error: '请填写姓名' }
  }

  const { count } = await supabase
    .from('attendance_members')
    .select('id', { count: 'exact', head: true })
    .eq('sheet_id', sheet_id)
  sortOrder = (count ?? 0) + 1

  const { data: member, error } = await supabase
    .from('attendance_members')
    .insert({ sheet_id, profile_id: profile_id ?? null, name: finalName, sort_order: sortOrder })
    .select('id')
    .single()
  if (error || !member) {
    if (error?.code === '23505') return { ok: false, error: '该成员已存在' }
    return { ok: false, error: `添加成员失败：${error?.message ?? '未知错误'}` }
  }
  revalidateAttendance()
  return { ok: true, member_id: member.id }
}

// 移除成员：级联删除其全部考勤格。
export async function removeAttendanceMember(input: {
  member_id: string
}): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = memberIdSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: '参数不合法' }
  const supabase = await createClient()
  const { error } = await supabase
    .from('attendance_members')
    .delete()
    .eq('id', parsed.data.member_id)
  if (error) return { ok: false, error: `移除成员失败：${error.message}` }
  revalidateAttendance()
  return { ok: true }
}

export async function upsertAttendanceEntry(input: {
  sheet_id: string
  member_id: string
  day: number
  morning: string
  afternoon: string
  morning_leave_hours?: number | null
  afternoon_leave_hours?: number | null
  morning_leave_type?: 'personal' | 'sick' | 'vacation' | null
  afternoon_leave_type?: 'personal' | 'sick' | 'vacation' | null
}): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = upsertEntrySchema.safeParse(normalizeCell(input))
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const { sheet_id, member_id, day, morning, afternoon, ...hourly } = parsed.data
  const supabase = await createClient()

  if (!morning && !afternoon) {
    const { error } = await supabase
      .from('attendance_entries')
      .delete()
      .eq('sheet_id', sheet_id)
      .eq('member_id', member_id)
      .eq('day', day)
    if (error) return { ok: false, error: `清除考勤格失败：${error.message}` }
    revalidateAttendance()
    return { ok: true }
  }

  const { error } = await supabase.from('attendance_entries').upsert(
    { sheet_id, member_id, profile_id: null, day, morning, afternoon, ...hourly },
    { onConflict: 'sheet_id,member_id,day' },
  )
  if (error) return { ok: false, error: `保存考勤格失败：${error.message}` }
  revalidateAttendance()
  return { ok: true }
}

// 批量保存（笔刷刷选）：整表刷选最多几百人 × 31 天，逐格往返会串行发出数千次请求，
// 这里按批 upsert，清除项按成员合并成一次 delete。
const ATTENDANCE_UPSERT_BATCH = 500

export async function batchUpsertAttendanceEntries(input: {
  sheet_id: string
  items: {
    member_id: string
    day: number
    morning: string
    afternoon: string
    morning_leave_hours?: number | null
    afternoon_leave_hours?: number | null
    morning_leave_type?: 'personal' | 'sick' | 'vacation' | null
    afternoon_leave_type?: 'personal' | 'sick' | 'vacation' | null
  }[]
}): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = batchUpsertSchema.safeParse({
    ...input,
    items: input.items.map(normalizeCell),
  })
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const supabase = await createClient()

  const upserts = parsed.data.items
    .filter((item) => item.morning || item.afternoon)
    .map((item) => ({
      sheet_id: parsed.data.sheet_id,
      member_id: item.member_id,
      profile_id: null,
      day: item.day,
      morning: item.morning,
      afternoon: item.afternoon,
      morning_leave_hours: item.morning_leave_hours ?? 0,
      afternoon_leave_hours: item.afternoon_leave_hours ?? 0,
      morning_leave_type: item.morning_leave_type ?? null,
      afternoon_leave_type: item.afternoon_leave_type ?? null,
    }))
  const clearsByMember = new Map<string, number[]>()
  for (const item of parsed.data.items) {
    if (item.morning || item.afternoon) continue
    const days = clearsByMember.get(item.member_id) ?? []
    days.push(item.day)
    clearsByMember.set(item.member_id, days)
  }

  for (let index = 0; index < upserts.length; index += ATTENDANCE_UPSERT_BATCH) {
    const { error } = await supabase
      .from('attendance_entries')
      .upsert(upserts.slice(index, index + ATTENDANCE_UPSERT_BATCH), {
        onConflict: 'sheet_id,member_id,day',
      })
    if (error) return { ok: false, error: `保存考勤格失败：${error.message}` }
  }

  for (const [memberId, days] of clearsByMember) {
    const { error } = await supabase
      .from('attendance_entries')
      .delete()
      .eq('sheet_id', parsed.data.sheet_id)
      .eq('member_id', memberId)
      .in('day', days)
    if (error) return { ok: false, error: `清除考勤格失败：${error.message}` }
  }

  revalidateAttendance()
  return { ok: true }
}
