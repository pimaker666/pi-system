'use server'

// 考勤表动作。校验 schema 为本文件私有；维护入口仅财务/管理员（触发器同名校验）。

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireApproved } from '@/lib/auth'
import { ATTENDANCE_SYMBOL_SET } from '@/lib/attendance'
import type { ActionResult } from './products'

const monthSchema = z.string().regex(/^\d{4}-\d{2}-01$/, '月份格式须为 yyyy-mm')

const createSheetSchema = z.object({
  month: monthSchema,
  note: z.string().trim().max(500, '备注最长 500 字').nullable().optional(),
})

const sheetIdSchema = z.object({
  sheet_id: z.string().uuid(),
})

const upsertEntrySchema = z.object({
  sheet_id: z.string().uuid(),
  profile_id: z.string().uuid(),
  day: z.coerce.number().int('日期须为整数').min(1, '日期不合法').max(31, '日期不合法'),
  morning: z.string().refine((value) => ATTENDANCE_SYMBOL_SET.includes(value) || value === '', {
    message: '考勤符号不合法',
  }),
  afternoon: z.string().refine((value) => ATTENDANCE_SYMBOL_SET.includes(value) || value === '', {
    message: '考勤符号不合法',
  }),
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

export async function upsertAttendanceEntry(input: {
  sheet_id: string
  profile_id: string
  day: number
  morning: string
  afternoon: string
}): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = upsertEntrySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const { sheet_id, profile_id, day, morning, afternoon } = parsed.data
  const supabase = await createClient()

  if (!morning && !afternoon) {
    const { error } = await supabase
      .from('attendance_entries')
      .delete()
      .eq('sheet_id', sheet_id)
      .eq('profile_id', profile_id)
      .eq('day', day)
    if (error) return { ok: false, error: `清除考勤格失败：${error.message}` }
    revalidateAttendance()
    return { ok: true }
  }

  const { error } = await supabase.from('attendance_entries').upsert(
    { sheet_id, profile_id, day, morning, afternoon },
    { onConflict: 'sheet_id,profile_id,day' },
  )
  if (error) return { ok: false, error: `保存考勤格失败：${error.message}` }
  revalidateAttendance()
  return { ok: true }
}
