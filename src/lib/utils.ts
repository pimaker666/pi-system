import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Decimal-safe rounding that also handles values represented with scientific notation. */
export function roundToScale(value: number, scale: number) {
  const [coefficient, exponent = '0'] = value.toString().split('e')
  const shifted = Number(`${coefficient}e${Number(exponent) + scale}`)
  return Number(`${Math.round(shifted)}e-${scale}`)
}

/**
 * Resolve a user's current display name for selectors and account-management UI.
 * Historical records pass their stored name snapshot as the second argument; the
 * snapshot must win so later account-name changes never rewrite history.
 */
export function displayProfileName(
  profile?: {
    chinese_name?: string | null
    full_name?: string | null
    email?: string | null
  } | null,
  historicalSnapshot?: string | null,
): string {
  const snapshot = historicalSnapshot?.trim()
  if (snapshot) return snapshot

  if (profile) {
    const live =
      profile.chinese_name?.trim() || profile.full_name?.trim() || profile.email?.trim()
    if (live) return live
  }
  return '—'
}

const CURRENCY_LOCALE: Record<string, string> = {
  USD: 'en-US',
  EUR: 'de-DE',
  CNY: 'zh-CN',
  GBP: 'en-GB',
  JPY: 'ja-JP',
}

// 表格一次渲染会调用上千次，Intl 实例模块级复用，避免每次重新构造。
const AMOUNT_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
})
const DATE_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const DATE_TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

const CURRENCY_FORMATS = new Map<string, Intl.NumberFormat>()

// 全站数字口径：默认展示 2 位小数；输入支持 4 位，带 3-4 位小数的值按实际显示。
export function formatAmount(amount: number) {
  if (!Number.isFinite(amount)) return '—'
  return AMOUNT_FORMAT.format(amount)
}

export function formatCurrency(amount: number, currency = 'USD') {
  let formatter = CURRENCY_FORMATS.get(currency)
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(CURRENCY_LOCALE[currency] ?? 'en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      })
    } catch {
      return `${currency} ${formatAmount(amount)}`
    }
    CURRENCY_FORMATS.set(currency, formatter)
  }
  return formatter.format(amount)
}

export function formatDate(input: string | Date, withTime = false) {
  const d = typeof input === 'string' ? new Date(input) : input
  return (withTime ? DATE_TIME_FORMAT : DATE_FORMAT).format(d)
}
