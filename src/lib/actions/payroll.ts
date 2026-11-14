'use server'

// 工资表动作。校验 schema 为本文件私有。

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireApproved, hasCurrentPermission } from '@/lib/auth'
import { fetchConfirmedCommissionBySalesperson } from '@/lib/business-order-commissions-server'
import { calcAttendanceDeduction, countWeekdays } from '@/lib/payroll'
import { WORKDAY_HOURS } from '@/lib/leave'
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

const addItemSchema = z
  .object({
    sheet_id: z.string().uuid(),
    salary_profile_id: z.string().uuid().optional(),
    name: z.string().trim().min(1, '请填写员工姓名').max(50, '姓名最长 50 字').optional(),
  })
  .refine((value) => Boolean(value.salary_profile_id) !== Boolean(value.name), {
    message: '请选择薪资档案人员或填写姓名',
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
  id: z.string().uuid(),
  name: z.string().trim().min(1, '请填写姓名').max(50, '姓名最长 50 字').optional(),
  base_salary: money('基本工资'),
  social_insurance: money('社保代扣'),
  housing_fund: money('公积金代扣'),
})

const newSalaryProfileSchema = z
  .object({
    profile_id: z.string().uuid().optional(),
    name: z.string().trim().min(1, '请填写姓名').max(50, '姓名最长 50 字').optional(),
  })
  .refine((value) => Boolean(value.profile_id) !== Boolean(value.name), {
    message: '请选择系统账号或填写姓名',
  })

const salaryProfileIdSchema = z.object({
  id: z.string().uuid(),
})

function revalidatePayroll() {
  revalidatePath('/finance/payroll')
}

async function requireFinanceManager() {
  const profile = await requireApproved()
  if (!(await hasCurrentPermission('attendance.manage'))) {
    throw new Error('当前账号没有考勤工资管理权限')
  }
  return profile
}

type PayrollSupabase = Awaited<ReturnType<typeof createClient>>

interface PayrollAutofill {
  attendanceDaysByProfile: Map<string, number>
  commissionByProfile: Map<string, number>
}

interface PayrollRosterRow {
  id: string
  profile_id: string | null
  name: string
  base_salary: number | string
  social_insurance: number | string
  housing_fund: number | string
  sort_order: number
  profile: {
    status: string
    chinese_name: string | null
    full_name: string | null
    email: string | null
  } | null
}

function payrollProfileName(profile: { chinese_name: string | null; full_name: string | null; email: string | null }) {
  return profile.chinese_name?.trim() || profile.full_name?.trim() || profile.email?.trim() || '员工'
}

// 指定月份的自动带入口径：考勤表 √ 出勤天数、已确认结清提成（CNY）；底薪/社保/公积金取自薪资档案行。
async function loadPayrollAutofill(
  supabase: PayrollSupabase,
  month: string,
): Promise<PayrollAutofill> {
  const commissionByProfile = await fetchConfirmedCommissionBySalesperson(supabase, month)

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
      .select('profile_id, day, morning, afternoon, morning_leave_hours, afternoon_leave_hours')
      .in('sheet_id', attendanceSheetIds)
      .or('morning.eq.√,afternoon.eq.√')
    if (entryError) throw new Error(`考勤记录读取失败：${entryError.message}`)
    // 与考勤表汇总同口径：√ 按上/下午各 0.5 天累计；小时假按 1h = 1/7.5 天从 √ 里扣减
    for (const row of (presentEntries ?? []) as Array<{
      profile_id: string | null
      morning: string
      afternoon: string
      morning_leave_hours: number | null
      afternoon_leave_hours: number | null
    }>) {
      if (!row.profile_id) continue
      const halves = Number(row.morning === '√') + Number(row.afternoon === '√')
      if (halves === 0) continue
      const hourlyHours = Number(row.morning_leave_hours ?? 0) + Number(row.afternoon_leave_hours ?? 0)
      const days = Math.max(0, halves * 0.5 - hourlyHours / WORKDAY_HOURS)
      attendanceDaysByProfile.set(
        row.profile_id,
        Math.round(((attendanceDaysByProfile.get(row.profile_id) ?? 0) + days) * 100) / 100,
      )
    }
  }

  return { attendanceDaysByProfile, commissionByProfile }
}

const ID_CHUNK = 100

// 已推送工资表的金额对外承诺，改数前必须撤回发布；分批查询避免 PostgREST URL 超长。
async function findPublishedSheetIds(
  supabase: PayrollSupabase,
  itemIds: string[],
): Promise<{ published: Set<string>; error: string | null }> {
  const published = new Set<string>()
  const sheetIds = new Set<string>()
  for (let index = 0; index < itemIds.length; index += ID_CHUNK) {
    const { data, error } = await supabase
      .from('payroll_items')
      .select('sheet_id')
      .in('id', itemIds.slice(index, index + ID_CHUNK))
    if (error) return { published, error: `工资明细读取失败：${error.message}` }
    for (const row of (data ?? []) as { sheet_id: string }[]) sheetIds.add(row.sheet_id)
  }
  const ids = [...sheetIds]
  for (let index = 0; index < ids.length; index += ID_CHUNK) {
    const { data, error } = await supabase
      .from('payroll_sheets')
      .select('id')
      .in('id', ids.slice(index, index + ID_CHUNK))
      .eq('status', 'published')
    if (error) return { published, error: `工资表状态读取失败：${error.message}` }
    for (const row of (data ?? []) as { id: string }[]) published.add(row.id)
  }
  return { published, error: null }
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

  // 先取自动带入口径与薪资档案，失败在建表前中止，避免留下空表
  let autofill: PayrollAutofill | null = null
  try {
    autofill = await loadPayrollAutofill(supabase, month)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '自动取数失败' }
  }

  // 工资表人员以薪资档案为准：账号员工 + 无账号人员，薪资档案里删掉的人不会再自动入表。
  const { data: roster, error: rosterError } = await supabase
    .from('payroll_salary_profiles')
    .select(
      'id, profile_id, name, base_salary, social_insurance, housing_fund, sort_order, profile:profiles!payroll_salary_profiles_profile_id_fkey(status, chinese_name, full_name, email)',
    )
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })
  if (rosterError) {
    return { ok: false, error: `读取薪资档案失败：${rosterError.message}` }
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

  const staff = ((roster ?? []) as unknown as PayrollRosterRow[]).filter(
    (row) => !row.profile_id || row.profile?.status === 'approved',
  )

  if (staff.length > 0) {
    const { attendanceDaysByProfile, commissionByProfile } = autofill
    const { error: itemsError } = await supabase.from('payroll_items').insert(
      staff.map((row, index) => {
        const attendanceDays = row.profile_id
          ? (attendanceDaysByProfile.get(row.profile_id) ?? 0)
          : 0
        const baseSalary = Number(row.base_salary)
        return {
          sheet_id: sheet.id,
          profile_id: row.profile_id,
          salary_profile_id: row.id,
          employee_name: row.profile ? payrollProfileName(row.profile) : row.name,
          sort_order: index + 1,
          attendance_days: attendanceDays,
          base_salary: baseSalary,
          commission: row.profile_id ? (commissionByProfile.get(row.profile_id) ?? 0) : 0,
          social_insurance: Number(row.social_insurance),
          housing_fund: Number(row.housing_fund),
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
  const { data: sheet, error: readError } = await supabase
    .from('payroll_sheets')
    .select('status')
    .eq('id', parsed.data.sheet_id)
    .maybeSingle()
  if (readError) return { ok: false, error: `读取失败：${readError.message}` }
  if (!sheet) return { ok: false, error: '工资表不存在' }
  if (sheet.status === 'published') {
    return { ok: false, error: '工资表已推送员工确认，请先撤回发布再修改' }
  }
  const { data: updated, error } = await supabase
    .from('payroll_sheets')
    .update({
      payout_month: parsed.data.payout_month,
      ...(input.full_attendance_days !== undefined
        ? { full_attendance_days: parsed.data.full_attendance_days }
        : {}),
    })
    .eq('id', parsed.data.sheet_id)
    .eq('status', 'draft')
    .select('id')
  if (error) return { ok: false, error: `保存失败：${error.message}` }
  if (!updated || updated.length === 0) {
    return { ok: false, error: '工资表已推送员工确认，请先撤回发布再修改' }
  }
  revalidatePayroll()
  return { ok: true }
}

export async function savePayrollSalaryProfile(input: {
  id: string
  name?: string
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
  const { data: row, error: readError } = await supabase
    .from('payroll_salary_profiles')
    .select('id, profile_id')
    .eq('id', parsed.data.id)
    .maybeSingle()
  if (readError) return { ok: false, error: `读取薪资档案失败：${readError.message}` }
  if (!row) return { ok: false, error: '薪资档案不存在，请刷新后重试' }

  const { error } = await supabase
    .from('payroll_salary_profiles')
    .update({
      // 账号员工的姓名以账号资料为准，只有无账号人员允许在档案里改名
      ...(row.profile_id ? {} : { name: parsed.data.name }),
      base_salary: parsed.data.base_salary,
      social_insurance: parsed.data.social_insurance,
      housing_fund: parsed.data.housing_fund,
      updated_by: profile.id,
    })
    .eq('id', parsed.data.id)
  if (error) return { ok: false, error: `保存薪资档案失败：${error.message}` }
  revalidatePayroll()
  return { ok: true }
}

export async function createPayrollSalaryProfile(input: {
  profile_id?: string
  name?: string
}): Promise<ActionResult & { id?: string }> {
  await requireFinanceManager()
  const parsed = newSalaryProfileSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  }
  const supabase = await createClient()

  let name = parsed.data.name ?? ''
  let profileId: string | null = parsed.data.profile_id ?? null
  if (profileId) {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, status, chinese_name, full_name, email')
      .eq('id', profileId)
      .maybeSingle()
    if (profileError) return { ok: false, error: `读取账号失败：${profileError.message}` }
    if (!profile) return { ok: false, error: '账号不存在' }
    if (profile.status !== 'approved') return { ok: false, error: '该账号不是已启用状态，暂不能加入薪资档案' }
    name = payrollProfileName(profile)

    const { data: existing } = await supabase
      .from('payroll_salary_profiles')
      .select('id')
      .eq('profile_id', profileId)
      .maybeSingle()
    if (existing) return { ok: false, error: '该员工已在薪资档案中' }
  }

  const { data: lastRow } = await supabase
    .from('payroll_salary_profiles')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: created, error } = await supabase
    .from('payroll_salary_profiles')
    .insert({
      profile_id: profileId,
      name,
      sort_order: (lastRow?.sort_order ?? 0) + 1,
    })
    .select('id')
    .single()
  if (error) {
    if (error.code === '23505') return { ok: false, error: '该员工已在薪资档案中' }
    return { ok: false, error: `新增薪资档案失败：${error.message}` }
  }
  revalidatePayroll()
  return { ok: true, id: created.id }
}

export async function deletePayrollSalaryProfile(input: { id: string }): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = salaryProfileIdSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: '参数不合法' }
  const supabase = await createClient()
  const { error } = await supabase
    .from('payroll_salary_profiles')
    .delete()
    .eq('id', parsed.data.id)
  if (error) {
    return {
      ok: false,
      error: `删除薪资档案失败：${error.message}（若人员已在已推送的工资表中，请先撤回发布）`,
    }
  }
  revalidatePayroll()
  return { ok: true }
}

export async function publishPayrollSheet(input: { sheet_id: string }): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = sheetIdSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: '参数不合法' }
  const supabase = await createClient()
  // 无账号人员没有员工端，其工资条不推送；整表都没有账号员工时不允许推送
  const { count: pushableCount, error: countError } = await supabase
    .from('payroll_items')
    .select('id', { count: 'exact', head: true })
    .eq('sheet_id', parsed.data.sheet_id)
    .not('profile_id', 'is', null)
  if (countError) return { ok: false, error: `读取工资明细失败：${countError.message}` }
  if (!pushableCount) {
    return { ok: false, error: '工资表里没有系统账号员工，没有可推送的工资条' }
  }
  const { data: updated, error } = await supabase
    .from('payroll_sheets')
    .update({ status: 'published' })
    .eq('id', parsed.data.sheet_id)
    .eq('status', 'draft')
    .select('id')
  if (error) return { ok: false, error: `推送失败：${error.message}` }
  if (!updated || updated.length === 0) {
    return { ok: false, error: '工资表状态已变更，请刷新后重试' }
  }
  revalidatePayroll()
  return { ok: true }
}

export async function unpublishPayrollSheet(input: { sheet_id: string }): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = sheetIdSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: '参数不合法' }
  const supabase = await createClient()
  // RPC 原子完成：状态回 draft，历史确认字段一并重置
  const { error } = await supabase.rpc('unpublish_payroll_sheet', {
    p_sheet_id: parsed.data.sheet_id,
  })
  if (error) return { ok: false, error: `撤回失败：${error.message}` }
  revalidatePayroll()
  return { ok: true }
}

export async function deletePayrollSheet(input: { sheet_id: string }): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = sheetIdSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: '参数不合法' }
  const supabase = await createClient()
  const { data: sheet, error: readError } = await supabase
    .from('payroll_sheets')
    .select('status')
    .eq('id', parsed.data.sheet_id)
    .maybeSingle()
  if (readError) return { ok: false, error: `读取失败：${readError.message}` }
  if (!sheet) return { ok: false, error: '工资表不存在' }
  if (sheet.status === 'published') {
    return { ok: false, error: '工资表已推送员工确认，不能删除；如需重做请先撤回发布' }
  }
  const { error } = await supabase.from('payroll_sheets').delete().eq('id', parsed.data.sheet_id)
  if (error) return { ok: false, error: `删除失败：${error.message}` }
  revalidatePayroll()
  return { ok: true }
}

export async function addPayrollItem(input: {
  sheet_id: string
  salary_profile_id?: string
  name?: string
}): Promise<ActionResult> {
  await requireFinanceManager()
  const parsed = addItemSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? '参数不合法' }
  const supabase = await createClient()

  const { data: sheet, error: sheetError } = await supabase
    .from('payroll_sheets')
    .select('period_month, full_attendance_days, status')
    .eq('id', parsed.data.sheet_id)
    .single()
  if (sheetError || !sheet) return { ok: false, error: '工资表不存在' }
  if (sheet.status === 'published') {
    return { ok: false, error: '工资表已推送员工确认，请先撤回发布再调整人员' }
  }

  const rosterRowSelect =
    'id, profile_id, name, base_salary, social_insurance, housing_fund, sort_order'
  const rosterSelect = `${rosterRowSelect}, profile:profiles!payroll_salary_profiles_profile_id_fkey(status, chinese_name, full_name, email)`

  let roster: PayrollRosterRow
  if (parsed.data.salary_profile_id) {
    const { data, error } = await supabase
      .from('payroll_salary_profiles')
      .select(rosterSelect)
      .eq('id', parsed.data.salary_profile_id)
      .maybeSingle()
    if (error) return { ok: false, error: `读取薪资档案失败：${error.message}` }
    if (!data) return { ok: false, error: '薪资档案人员不存在，请刷新后重试' }
    roster = data as unknown as PayrollRosterRow
    if (roster.profile_id && roster.profile?.status !== 'approved') {
      return { ok: false, error: '该账号不是已启用状态，暂不能补入工资表' }
    }
  } else {
    // 补入无账号员工：同时写入薪资档案，后续新建工资表会继续带入
    const { data: lastRow } = await supabase
      .from('payroll_salary_profiles')
      .select('sort_order')
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle()
    const { data: created, error } = await supabase
      .from('payroll_salary_profiles')
      .insert({
        profile_id: null,
        name: parsed.data.name,
        sort_order: (lastRow?.sort_order ?? 0) + 1,
      })
      .select(rosterRowSelect)
      .single()
    if (error || !created) return { ok: false, error: `新增薪资档案失败：${error?.message ?? '未知错误'}` }
    roster = { ...(created as unknown as PayrollRosterRow), profile: null }
  }

  const month = (sheet.period_month as string).slice(0, 7)
  const fullAttendanceDays =
    sheet.full_attendance_days == null ? countWeekdays(month) : Number(sheet.full_attendance_days)

  let autofill: PayrollAutofill
  try {
    autofill = await loadPayrollAutofill(supabase, month)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '自动取数失败' }
  }
  const attendanceDays = roster.profile_id
    ? (autofill.attendanceDaysByProfile.get(roster.profile_id) ?? 0)
    : 0
  const baseSalary = Number(roster.base_salary)

  const { count } = await supabase
    .from('payroll_items')
    .select('id', { count: 'exact', head: true })
    .eq('sheet_id', parsed.data.sheet_id)
  const { error } = await supabase.from('payroll_items').insert({
    sheet_id: parsed.data.sheet_id,
    profile_id: roster.profile_id,
    salary_profile_id: roster.id,
    employee_name: roster.profile ? payrollProfileName(roster.profile) : roster.name,
    sort_order: (count ?? 0) + 1,
    attendance_days: attendanceDays,
    base_salary: baseSalary,
    commission: roster.profile_id ? (autofill.commissionByProfile.get(roster.profile_id) ?? 0) : 0,
    social_insurance: Number(roster.social_insurance),
    housing_fund: Number(roster.housing_fund),
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
  const lock = await findPublishedSheetIds(supabase, [parsed.data.item_id])
  if (lock.error) return { ok: false, error: lock.error }
  if (lock.published.size > 0) {
    return { ok: false, error: '工资表已推送员工确认，请先撤回发布再调整人员' }
  }
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
  const lock = await findPublishedSheetIds(supabase, parsed.data.rows.map((row) => row.id))
  if (lock.error) return { ok: false, error: lock.error }
  if (lock.published.size > 0) {
    return { ok: false, error: '工资表已推送员工确认，请先撤回发布再修改金额' }
  }
  const normalizedRows = parsed.data.rows.map(({ id, remark, ...fields }) => ({
    id,
    values: { ...fields, remark: remark && remark.trim() ? remark.trim() : null },
  }))
  let failure: string | null = null
  let cursor = 0
  const workerCount = Math.min(4, normalizedRows.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (failure === null) {
        const index = cursor++
        if (index >= normalizedRows.length) return
        const { id, values } = normalizedRows[index]
        const { error } = await supabase.from('payroll_items').update(values).eq('id', id)
        if (error && failure === null) failure = `保存失败：${error.message}`
      }
    }),
  )
  if (failure) return { ok: false, error: failure }
  revalidatePayroll()
  return { ok: true }
}

