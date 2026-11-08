import type { LeaveDayPart, LeaveStatus, LeaveType } from '@/types'

// 请假类型与考勤符号的映射：批准后自动写入考勤格。
export const LEAVE_TYPE_META: Record<
  LeaveType,
  { label: string; symbol: '○' | '☆' | '●' }
> = {
  personal: { label: '事假', symbol: '○' },
  sick: { label: '病假', symbol: '☆' },
  vacation: { label: '年假/调休', symbol: '●' },
}

export const LEAVE_DAY_PART_LABELS: Record<LeaveDayPart, string> = {
  full: '全天',
  morning: '仅上午',
  afternoon: '仅下午',
}

export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已驳回',
}

// 公司作息：每天 7.5 小时（上午 3.5、下午 4）。小时假按 0.5 小时步进，
// 上限为该半天工时减 0.5 小时；超过即应按半天请假处理。
export const WORKDAY_HOURS = 7.5
export const HALF_DAY_WORK_HOURS = { morning: 3.5, afternoon: 4 } as const
export const MAX_HOURLY_LEAVE = { morning: 3, afternoon: 3.5 } as const
export const HOURLY_LEAVE_STEP = 0.5

export type LeaveHalf = keyof typeof MAX_HOURLY_LEAVE

export function hourlyLeaveDayEquivalent(hours: number): number {
  return Math.round((hours / WORKDAY_HOURS) * 100) / 100
}

export function isValidHourlyLeave(hours: number, dayPart: LeaveHalf): boolean {
  if (!Number.isFinite(hours)) return false
  if (hours < HOURLY_LEAVE_STEP || hours > MAX_HOURLY_LEAVE[dayPart]) return false
  return Math.abs(hours / HOURLY_LEAVE_STEP - Math.round(hours / HOURLY_LEAVE_STEP)) < 1e-9
}

export function formatLeaveHours(hours: number): string {
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`
}

// 用本地年月日逐日推进，避免 toISOString 的时区回退把日期推前一天（跨月边界会写错月份）
export function daysBetweenInclusive(startDate: string, endDate: string): string[] {
  const days: string[] = []
  const [sy, sm, sd] = startDate.split('-').map(Number)
  const [ey, em, ed] = endDate.split('-').map(Number)
  const current = new Date(sy, sm - 1, sd)
  const end = new Date(ey, em - 1, ed)
  while (current <= end) {
    const y = current.getFullYear()
    const m = String(current.getMonth() + 1).padStart(2, '0')
    const d = String(current.getDate()).padStart(2, '0')
    days.push(`${y}-${m}-${d}`)
    current.setDate(current.getDate() + 1)
  }
  return days
}

export function monthKeyOf(date: string): string {
  return `${date.slice(0, 7)}-01`
}
