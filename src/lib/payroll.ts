import type { PayrollItem } from '@/types'

// 工资表模板口径（应发/应扣/实发不落库，展示侧统一由此计算，保证各页一致）。
export interface PayrollDerived {
  gross: number
  totalDeduction: number
  net: number
}

export function calcPayroll(
  item: Pick<
    PayrollItem,
    | 'base_salary'
    | 'commission'
    | 'bonus'
    | 'attendance_deduction'
    | 'other_deduction'
    | 'social_insurance'
    | 'housing_fund'
    | 'tax'
  >,
): PayrollDerived {
  const gross =
    Number(item.base_salary) +
    Number(item.commission) +
    Number(item.bonus) -
    Number(item.attendance_deduction)
  const totalDeduction =
    Number(item.other_deduction) +
    Number(item.social_insurance) +
    Number(item.housing_fund) +
    Number(item.tax)
  return { gross, totalDeduction, net: gross - totalDeduction }
}

/** 当月满勤天数默认口径：国家法定休假即排除周六日，统计当月周一~周五天数。 */
export function countWeekdays(periodMonth: string): number {
  const [year, month] = periodMonth.slice(0, 7).split('-').map(Number)
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  let count = 0
  for (let day = 1; day <= days; day += 1) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
    if (weekday >= 1 && weekday <= 5) count += 1
  }
  return count
}

// 考勤扣款=底薪/满勤天数×(满勤天数-实际出勤天数)；满勤天数为空或出勤满勤时不扣。
export function calcAttendanceDeduction(
  baseSalary: number,
  fullAttendanceDays: number | null,
  attendanceDays: number,
): number {
  if (!fullAttendanceDays || fullAttendanceDays <= 0) return 0
  if (attendanceDays >= fullAttendanceDays) return 0
  return Math.round(((baseSalary / fullAttendanceDays) * (fullAttendanceDays - attendanceDays)) * 100) / 100
}

export const PAYROLL_CONFIRMATION_LABELS: Record<PayrollItem['confirmation'], string> = {
  pending: '待确认',
  confirmed: '已确认',
  rejected: '已驳回',
}

export const PAYROLL_SHEET_STATUS_LABELS: Record<'draft' | 'published', string> = {
  draft: '草稿',
  published: '已推送确认',
}
