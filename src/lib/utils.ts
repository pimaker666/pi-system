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

export function formatCurrency(amount: number, currency = 'USD') {
  try {
    return new Intl.NumberFormat(CURRENCY_LOCALE[currency] ?? 'en-US', {
      style: 'currency',
      currency,
    }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

export function formatDate(input: string | Date, withTime = false) {
  const d = typeof input === 'string' ? new Date(input) : input
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }
  return new Intl.DateTimeFormat('zh-CN', opts).format(d)
}
