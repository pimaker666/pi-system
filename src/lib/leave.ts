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
