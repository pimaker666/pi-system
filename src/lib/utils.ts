import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Resolve a user's display name for the UI: prefer the live `chinese_name`,
 * then `full_name`, then `email`. When the joined profile is absent (e.g. the
 * user was deleted and only the historical `*_name_snapshot` survives), fall
 * back to the provided snapshot string. Returns '—' when nothing is available.
 */
export function displayProfileName(
  profile?: {
    chinese_name?: string | null
    full_name?: string | null
    email?: string | null
  } | null,
  fallbackSnapshot?: string | null,
): string {
  if (profile) {
    const live =
      profile.chinese_name?.trim() || profile.full_name?.trim() || profile.email?.trim()
    if (live) return live
  }
  return fallbackSnapshot?.trim() || '—'
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
