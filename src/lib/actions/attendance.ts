'use server'

// 考勤表动作。校验 schema 为本文件私有；维护入口仅财务/管理员（触发器同名校验）。

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireApproved } from '@/lib/auth'
import { ATTENDANCE_SYMBOL_SET } from '@/lib/attendance'
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

const upsertEntrySchema = z.object({
  sheet_id: z.string().uuid(),
  member_id: z.string().uuid(),
  day: z.coerce.number().int('日期须为整数').min(1, '日期不合法').max(31, '日期不合法'),
  morning: symbolOrEmpty,
  afternoon: symbolOrEmpty,
})

const batchUpsertSchema = z.object({
  sheet_id: z.string().uuid(),
  items: z
    .array(
      z.object({
        member_id: z.string().uuid(),
        day: z.coerce.number().int('日期须为整数').min(1, '日期不合法').max(31, '日期不合法'),
        morning: symbolOrEmpty,
        afternoon: symbolOrEmpty,
      }),
    )
    .min(1, '没有需要保存的考勤格')
    .max(31 * 200, '单次批量范围过大'),
})

const updateNoteSchema = z.object({
  sheet_id: z.string().uuid(),
  note: z.string().trim().max(500, '备注最长 500 字').nullable(),
})

function revalidateAttendance() {
  revalidatePath('/finance/attendance')
}

async function requireFinanceManager() {
  const profile = await requireApproved()
  if (profile.role !== 'admin' && profile.role !== 'finance') {
    throw new Error('仅财务或管理员可操作')
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
}): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = upsertEntrySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const { sheet_id, member_id, day, morning, afternoon } = parsed.data
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
    { sheet_id, member_id, profile_id: null, day, morning, afternoon },
    { onConflict: 'sheet_id,member_id,day' },
  )
  if (error) return { ok: false, error: `保存考勤格失败：${error.message}` }
  revalidateAttendance()
  return { ok: true }
}

// 批量保存（笔刷刷选）：逐格 upsert/清除，全部完成后统一 revalidate。
export async function batchUpsertAttendanceEntries(input: {
  sheet_id: string
  items: { member_id: string; day: number; morning: string; afternoon: string }[]
}): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = batchUpsertSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const supabase = await createClient()

  for (const item of parsed.data.items) {
    if (!item.morning && !item.afternoon) {
      const { error } = await supabase
        .from('attendance_entries')
        .delete()
        .eq('sheet_id', parsed.data.sheet_id)
        .eq('member_id', item.member_id)
        .eq('day', item.day)
      if (error) return { ok: false, error: `保存失败（${item.day}日）：${error.message}` }
    } else {
      const { error } = await supabase.from('attendance_entries').upsert(
        {
          sheet_id: parsed.data.sheet_id,
          member_id: item.member_id,
          profile_id: null,
          day: item.day,
          morning: item.morning,
          afternoon: item.afternoon,
        },
        { onConflict: 'sheet_id,member_id,day' },
      )
      if (error) return { ok: false, error: `保存失败（${item.day}日）：${error.message}` }
    }
  }
  revalidateAttendance()
  return { ok: true }
}
