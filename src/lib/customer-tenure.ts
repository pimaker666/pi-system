/**
 * 客户年限按自然月折算为年（6 个月 = 0.5 年），保留 1 位小数；排序用整月数。
 * 月数按年月差计算、不看具体日期，所以整体在每月 1 号统一 +1 个月。
 */
export function customerTenureMonths(
  firstOrderDate: string | null | undefined,
  now: Date = new Date(),
): number | undefined {
  if (!firstOrderDate) return undefined
  const start = new Date(`${firstOrderDate.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(start.getTime())) return undefined
  const months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth())
  return Math.max(months, 0)
}

export function formatCustomerTenure(
  firstOrderDate: string | null | undefined,
  now: Date = new Date(),
): string {
  const months = customerTenureMonths(firstOrderDate, now)
  if (months === undefined) return '—'
  const years = Math.round((months / 12) * 10) / 10
  return `${years}年`
}
