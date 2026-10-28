'use server'

// 工资表动作。校验 schema 为本文件私有。

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireApproved } from '@/lib/auth'
import { fetchConfirmedCommissionBySalesperson } from '@/lib/business-order-commissions-server'
import { calcAttendanceDeduction, countWeekdays } from '@/lib/payroll'
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
  full_attendance_days: z.coerce
    .number({ invalid_type_error: '满勤天数须为数字' })
    .int('满勤天数须为整数')
    .min(1, '满勤天数至少 1 天')
    .max(31, '满勤天数最多 31 天')
    .nullish(),
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

const salaryProfileSchema = z.object({
  profile_id: z.string().uuid(),
  base_salary: money('基本工资'),
  social_insurance: money('社保代扣'),
  housing_fund: money('公积金代扣'),
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

type PayrollSupabase = Awaited<ReturnType<typeof createClient>>

interface PayrollAutofill {
  salaryByProfile: Map<string, { base_salary: number; social_insurance: number; housing_fund: number }>
  attendanceDaysByProfile: Map<string, number>
  commissionByProfile: Map<string, number>
}

// 指定月份的自动带入口径：薪资档案（底薪/社保/公积金）、考勤表 √ 出勤天数、已确认结清提成（CNY）。
async function loadPayrollAutofill(
  supabase: PayrollSupabase,
  month: string,
): Promise<PayrollAutofill> {
  const [salaryRes, commissionByProfile] = await Promise.all([
    supabase.from('payroll_salary_profiles').select('profile_id, base_salary, social_insurance, housing_fund'),
    fetchConfirmedCommissionBySalesperson(supabase, month),
  ])
  if (salaryRes.error) {
    throw new Error(`薪资档案读取失败：${salaryRes.error.message}`)
  }
  const salaryByProfile = new Map(
    (salaryRes.data ?? []).map((row) => [
      row.profile_id as string,
      {
        base_salary: Number(row.base_salary),
        social_insurance: Number(row.social_insurance),
        housing_fund: Number(row.housing_fund),
      },
    ]),
  )

  const { data: attendanceSheets, error: sheetError } = await supabase
    .from('attendance_sheets')
    .select('id')
    .eq('month', `${month}-01`)
  if (sheetError) throw new Error(`考勤表读取失败：${sheetError.message}`)
  const attendanceSheetIds = (attendanceSheets ?? []).map((row) => row.id as string)

  const attendanceDaysByProfile = new Map<string, number>()
  if (attendanceSheetIds.length > 0) {
    const { data: presentEntries, error: entryError } = await supabase
      .from('attendance_entries')
      .select('profile_id, day')
      .in('sheet_id', attendanceSheetIds)
      .or('morning.eq.√,afternoon.eq.√')
    if (entryError) throw new Error(`考勤记录读取失败：${entryError.message}`)
    const seen = new Set<string>()
    for (const row of (presentEntries ?? []) as Array<{ profile_id: string | null; day: number }>) {
      if (!row.profile_id) continue
      const key = `${row.profile_id}:${row.day}`
      if (seen.has(key)) continue
      seen.add(key)
      attendanceDaysByProfile.set(row.profile_id, (attendanceDaysByProfile.get(row.profile_id) ?? 0) + 1)
    }
  }

  return { salaryByProfile, attendanceDaysByProfile, commissionByProfile }
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

  const month = parsed.data.period_month.slice(0, 7)
  const fullAttendanceDays = countWeekdays(month)

  // 先取自动带入口径，失败在建表前中止，避免留下空表
  let autofill: PayrollAutofill | null = null
  try {
    autofill = await loadPayrollAutofill(supabase, month)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '自动取数失败' }
  }

  const { data: sheet, error: sheetError } = await supabase
    .from('payroll_sheets')
    .insert({
      period_month: parsed.data.period_month,
      payout_month: parsed.data.payout_month ?? null,
      full_attendance_days: fullAttendanceDays,
      created_by: profile.id,
    })
    .select('id')
    .single()
  if (sheetError || !sheet) {
    return { ok: false, error: `创建工资表失败：${sheetError?.message ?? '未知错误'}` }
  }

  // 全员（已启用账号）默认入表，按账号创建时间排序号；薪资档案/考勤/已确认提成自动带入。
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
    const { salaryByProfile, attendanceDaysByProfile, commissionByProfile } = autofill
    const { error: itemsError } = await supabase.from('payroll_items').insert(
      profiles.map((row, index) => {
        const salary = salaryByProfile.get(row.id)
        const attendanceDays = attendanceDaysByProfile.get(row.id) ?? 0
        const baseSalary = salary?.base_salary ?? 0
        return {
          sheet_id: sheet.id,
          profile_id: row.id,
          sort_order: index + 1,
          attendance_days: attendanceDays,
          base_salary: baseSalary,
          commission: commissionByProfile.get(row.id) ?? 0,
          social_insurance: salary?.social_insurance ?? 0,
          housing_fund: salary?.housing_fund ?? 0,
          attendance_deduction: calcAttendanceDeduction(baseSalary, fullAttendanceDays, attendanceDays),
        }
      }),
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
  full_attendance_days?: number | null
}): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = updateSheetMetaSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const supabase = await createClient()
  const { error } = await supabase
    .from('payroll_sheets')
    .update({
      payout_month: parsed.data.payout_month,
      ...(input.full_attendance_days !== undefined
        ? { full_attendance_days: parsed.data.full_attendance_days }
        : {}),
    })
    .eq('id', parsed.data.sheet_id)
  if (error) return { ok: false, error: `保存失败：${error.message}` }
  revalidatePayroll()
  return { ok: true }
}

export async function savePayrollSalaryProfile(input: {
  profile_id: string
  base_salary: number
  social_insurance: number
  housing_fund: number
}): Promise<ActionResult> {
  const profile = await requireFinanceManager()
  const parsed = salaryProfileSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const supabase = await createClient()
  const { error } = await supabase.from('payroll_salary_profiles').upsert(
    {
      profile_id: parsed.data.profile_id,
      base_salary: parsed.data.base_salary,
      social_insurance: parsed.data.social_insurance,
      housing_fund: parsed.data.housing_fund,
      updated_by: profile.id,
    },
    { onConflict: 'profile_id' },
  )
  if (error) return { ok: false, error: `保存薪资档案失败：${error.message}` }
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

  const { data: sheet, error: sheetError } = await supabase
    .from('payroll_sheets')
    .select('period_month, full_attendance_days')
    .eq('id', parsed.data.sheet_id)
    .single()
  if (sheetError || !sheet) return { ok: false, error: '工资表不存在' }

  const month = (sheet.period_month as string).slice(0, 7)
  const fullAttendanceDays =
    sheet.full_attendance_days == null ? countWeekdays(month) : Number(sheet.full_attendance_days)

  let autofill: PayrollAutofill
  try {
    autofill = await loadPayrollAutofill(supabase, month)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '自动取数失败' }
  }
  const salary = autofill.salaryByProfile.get(parsed.data.profile_id)
  const attendanceDays = autofill.attendanceDaysByProfile.get(parsed.data.profile_id) ?? 0
  const baseSalary = salary?.base_salary ?? 0

  const { count } = await supabase
    .from('payroll_items')
    .select('id', { count: 'exact', head: true })
    .eq('sheet_id', parsed.data.sheet_id)
  const { error } = await supabase.from('payroll_items').insert({
    sheet_id: parsed.data.sheet_id,
    profile_id: parsed.data.profile_id,
    sort_order: (count ?? 0) + 1,
    attendance_days: attendanceDays,
    base_salary: baseSalary,
    commission: autofill.commissionByProfile.get(parsed.data.profile_id) ?? 0,
    social_insurance: salary?.social_insurance ?? 0,
    housing_fund: salary?.housing_fund ?? 0,
    attendance_deduction: calcAttendanceDeduction(baseSalary, fullAttendanceDays, attendanceDays),
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
