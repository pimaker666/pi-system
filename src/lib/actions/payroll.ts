'use server'

// 工资表动作。校验 schema 为本文件私有。

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireApproved } from '@/lib/auth'
import type { ActionResult } from './products'

const monthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-01$/, '月份格式须为 yyyy-mm')

const createSheetSchema = z.object({
  period_month: monthSchema,
  payout_month: monthSchema.nullable().optional(),
})

const updateSheetMetaSchema = z.object({
  sheet_id: z.string().uuid(),
  payout_month: monthSchema.nullable(),
})

const sheetIdSchema = z.object({
  sheet_id: z.string().uuid(),
})

const addItemSchema = z.object({
  sheet_id: z.string().uuid(),
  profile_id: z.string().uuid(),
})

const removeItemSchema = z.object({
  item_id: z.string().uuid(),
})

const money = (label: string) =>
  z.coerce.number({ invalid_type_error: `${label}须为数字` }).min(0, `${label}不能为负`).max(999999999, `${label}超出范围`)

const itemRowSchema = z.object({
  id: z.string().uuid(),
  attendance_days: money('出勤天数').max(62, '出勤天数超出范围'),
  base_salary: money('基本工资'),
  commission: money('提成'),
  bonus: money('奖金'),
  attendance_deduction: money('考勤扣款'),
  other_deduction: money('其他扣款'),
  social_insurance: money('社保代扣'),
  housing_fund: money('公积金代扣'),
  tax: money('个税扣款'),
  remark: z.string().trim().max(500, '备注最长 500 字').nullable(),
})

const updateItemsSchema = z.object({
  rows: z.array(itemRowSchema).min(1).max(500),
})

const rejectSchema = z.object({
  item_id: z.string().uuid(),
  reason: z.string().trim().min(1, '请填写驳回原因').max(500, '驳回原因最长 500 字'),
})

const itemIdSchema = z.object({
  item_id: z.string().uuid(),
})

function revalidatePayroll() {
  revalidatePath('/finance/payroll')
}

async function requireFinanceManager() {
  const profile = await requireApproved()
  if (profile.role !== 'admin' && profile.role !== 'finance') {
    throw new Error('仅财务或管理员可操作')
  }
  return profile
}

export async function createPayrollSheet(input: {
  period_month: string
  payout_month?: string | null
}): Promise<ActionResult & { sheet_id?: string }> {
  const profile = await requireFinanceManager()
  const parsed = createSheetSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const supabase = await createClient()

  const { data: sheet, error: sheetError } = await supabase
    .from('payroll_sheets')
    .insert({
      period_month: parsed.data.period_month,
      payout_month: parsed.data.payout_month ?? null,
      created_by: profile.id,
    })
    .select('id')
    .single()
  if (sheetError || !sheet) {
    return { ok: false, error: `创建工资表失败：${sheetError?.message ?? '未知错误'}` }
  }

  // 全员（已启用账号）默认入表，按账号创建时间排序号
  const { data: profiles, error: profilesError } = await supabase
    .from('profiles')
    .select('id')
    .eq('status', 'approved')
    .order('created_at', { ascending: true })
    .order('full_name', { ascending: true })
  if (profilesError) {
    return { ok: false, error: `读取员工列表失败：${profilesError.message}` }
  }

  if (profiles && profiles.length > 0) {
    const { error: itemsError } = await supabase.from('payroll_items').insert(
      profiles.map((row, index) => ({
        sheet_id: sheet.id,
        profile_id: row.id,
        sort_order: index + 1,
      })),
    )
    if (itemsError) {
      return { ok: false, error: `初始化工资明细失败：${itemsError.message}` }
    }
  }

  revalidatePayroll()
  return { ok: true, sheet_id: sheet.id }
}

export async function updatePayrollSheetMeta(input: {
  sheet_id: string
  payout_month: string | null
}): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = updateSheetMetaSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const supabase = await createClient()
  const { error } = await supabase
    .from('payroll_sheets')
    .update({ payout_month: parsed.data.payout_month })
    .eq('id', parsed.data.sheet_id)
  if (error) return { ok: false, error: `保存失败：${error.message}` }
  revalidatePayroll()
  return { ok: true }
}

export async function publishPayrollSheet(input: { sheet_id: string }): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = sheetIdSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: '参数不合法' }
  const supabase = await createClient()
  const { error } = await supabase
    .from('payroll_sheets')
    .update({ status: 'published' })
    .eq('id', parsed.data.sheet_id)
    .eq('status', 'draft')
  if (error) return { ok: false, error: `推送失败：${error.message}` }
  revalidatePayroll()
  return { ok: true }
}

export async function deletePayrollSheet(input: { sheet_id: string }): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = sheetIdSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: '参数不合法' }
  const supabase = await createClient()
  const { error } = await supabase.from('payroll_sheets').delete().eq('id', parsed.data.sheet_id)
  if (error) return { ok: false, error: `删除失败：${error.message}` }
  revalidatePayroll()
  return { ok: true }
}

export async function addPayrollItem(input: {
  sheet_id: string
  profile_id: string
}): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = addItemSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: '参数不合法' }
  const supabase = await createClient()

  const { count } = await supabase
    .from('payroll_items')
    .select('id', { count: 'exact', head: true })
    .eq('sheet_id', parsed.data.sheet_id)
  const { error } = await supabase.from('payroll_items').insert({
    sheet_id: parsed.data.sheet_id,
    profile_id: parsed.data.profile_id,
    sort_order: (count ?? 0) + 1,
  })
  if (error) {
    if (error.code === '23505') return { ok: false, error: '该员工已在此工资表中' }
    return { ok: false, error: `添加失败：${error.message}` }
  }
  revalidatePayroll()
  return { ok: true }
}

export async function removePayrollItem(input: { item_id: string }): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = removeItemSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: '参数不合法' }
  const supabase = await createClient()
  const { error } = await supabase.from('payroll_items').delete().eq('id', parsed.data.item_id)
  if (error) return { ok: false, error: `移除失败：${error.message}` }
  revalidatePayroll()
  return { ok: true }
}

export async function updatePayrollItems(input: {
  rows: {
    id: string
    attendance_days: number
    base_salary: number
    commission: number
    bonus: number
    attendance_deduction: number
    other_deduction: number
    social_insurance: number
    housing_fund: number
    tax: number
    remark: string | null
  }[]
}): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = updateItemsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const supabase = await createClient()
  for (const row of parsed.data.rows) {
    const { id, remark, ...fields } = row
    const normalized = {
      ...fields,
      remark: remark && remark.trim() ? remark.trim() : null,
    }
    const { error } = await supabase.from('payroll_items').update(normalized).eq('id', id)
    if (error) return { ok: false, error: `保存失败：${error.message}` }
  }
  revalidatePayroll()
  return { ok: true }
}

export async function confirmOwnPayrollItem(input: { item_id: string }): Promise<ActionResult> {
  const profile = await requireApproved()
  const parsed = itemIdSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: '参数不合法' }
  const supabase = await createClient()

  const { data: item, error: readError } = await supabase
    .from('payroll_items')
    .select('id, profile_id')
    .eq('id', parsed.data.item_id)
    .single()
  if (readError || !item) return { ok: false, error: '工资条不存在' }
  if (item.profile_id !== profile.id) return { ok: false, error: '只能确认自己的工资条' }

  const { error } = await supabase
    .from('payroll_items')
    .update({ confirmation: 'confirmed' })
    .eq('id', parsed.data.item_id)
    .eq('confirmation', 'pending')
  if (error) return { ok: false, error: `确认失败：${error.message}` }
  revalidatePayroll()
  return { ok: true }
}

export async function rejectOwnPayrollItem(input: {
  item_id: string
  reason: string
}): Promise<ActionResult> {
  const profile = await requireApproved()
  const parsed = rejectSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const supabase = await createClient()

  const { data: item, error: readError } = await supabase
    .from('payroll_items')
    .select('id, profile_id')
    .eq('id', parsed.data.item_id)
    .single()
  if (readError || !item) return { ok: false, error: '工资条不存在' }
  if (item.profile_id !== profile.id) return { ok: false, error: '只能驳回自己的工资条' }

  const { error } = await supabase
    .from('payroll_items')
    .update({
      confirmation: 'rejected',
      rejected_reason: parsed.data.reason,
    })
    .eq('id', parsed.data.item_id)
    .eq('confirmation', 'pending')
  if (error) return { ok: false, error: `驳回失败：${error.message}` }
  revalidatePayroll()
  return { ok: true }
}
