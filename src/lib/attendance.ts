// 考勤符号口径与汇总规则，对齐公司考勤表模板：
// 天数字段按上/下午各计 0.5 天（同一天同一符号最多计 1 天），次数字段按格子出现次数累计。

export const ATTENDANCE_SYMBOLS = [
  { symbol: '√', label: '出勤', kind: 'day' },
  { symbol: '●', label: '休假', kind: 'day' },
  { symbol: '○', label: '请假', kind: 'day' },
  { symbol: '☆', label: '病假', kind: 'day' },
  { symbol: '△', label: '外勤', kind: 'day' },
  { symbol: '▲', label: '出差', kind: 'day' },
  { symbol: '×', label: '旷工', kind: 'day' },
  { symbol: '※', label: '迟到', kind: 'times' },
  { symbol: '◇', label: '早退', kind: 'times' },
  { symbol: '◆', label: '中途离岗', kind: 'times' },
] as const

export type AttendanceSymbol = (typeof ATTENDANCE_SYMBOLS)[number]['symbol']

export const ATTENDANCE_SYMBOL_SET: readonly string[] = ATTENDANCE_SYMBOLS.map((s) => s.symbol)

export function isAttendanceSymbol(value: string): value is AttendanceSymbol {
  return (ATTENDANCE_SYMBOL_SET as readonly string[]).includes(value)
}

export interface AttendanceSummary {
  /** symbol -> 天数（day 类）或次数（times 类） */
  counts: Record<string, number>
}

export function summarizeAttendance(
  entries: { day: number; morning: string; afternoon: string }[],
): AttendanceSummary {
  const counts: Record<string, number> = {}
  for (const { symbol } of ATTENDANCE_SYMBOLS) counts[symbol] = 0

  for (const entry of entries) {
    const halfDays: Record<string, number> = {}
    for (const value of [entry.morning, entry.afternoon]) {
      if (!value) continue
      if (!isAttendanceSymbol(value)) continue
      const kind = ATTENDANCE_SYMBOLS.find((s) => s.symbol === value)?.kind
      if (kind === 'times') {
        counts[value] += 1
      } else {
        halfDays[value] = (halfDays[value] ?? 0) + 0.5
      }
    }
    for (const [symbol, amount] of Object.entries(halfDays)) {
      counts[symbol] += Math.min(amount, 1)
    }
  }
  return { counts }
}
