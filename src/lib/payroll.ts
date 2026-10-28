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

export const PAYROLL_CONFIRMATION_LABELS: Record<PayrollItem['confirmation'], string> = {
  pending: '待确认',
  confirmed: '已确认',
  rejected: '已驳回',
}

export const PAYROLL_SHEET_STATUS_LABELS: Record<'draft' | 'published', string> = {
  draft: '草稿',
  published: '已推送确认',
}
