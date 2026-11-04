/** 北京时间的日历日期（YYYY-MM-DD）。前后端共用，避免 toISOString 在 UTC+8 凌晨回退一天。 */
export function chinaToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

/** 北京时间的当前月份（YYYY-MM）。 */
export function chinaCurrentMonth(): string {
  return chinaToday().slice(0, 7)
}
