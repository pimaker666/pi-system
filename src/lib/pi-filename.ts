import type { ProformaInvoice } from '@/types'

/** Strip characters that are illegal / awkward in filenames. */
function sanitize(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '') // illegal on Windows
    .replace(/\s+/g, ' ') // collapse whitespace to a single space
    .trim()
}

/** yyyyMMdd from an ISO date string. */
function yyyymmdd(iso: string): string {
  const d = new Date(iso)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

/** Trailing numeric run of the PI number, e.g. "PI-2026-001" -> "001". */
function sequence(piNumber: string): string {
  return piNumber.match(/(\d+)$/)?.[1] ?? ''
}

export interface PiFilename {
  /** Human-readable base without extension, e.g. "某客户PI20260715001". */
  base: string
  /** Full name with extension, may contain non-ASCII. */
  full: string
  /** ASCII-safe fallback name for the `filename=` param. */
  ascii: string
  /** RFC 5987 encoded value for the `filename*=UTF-8''` param. */
  encoded: string
}

/**
 * Build the default download filename:
 *   客户名 + " PI " + yyyyMMdd + " " + PI流水号  (space-separated)
 * e.g. 某客户 PI 20260715 001.pdf
 */
export function buildPiFilename(
  pi: Pick<ProformaInvoice, 'pi_number' | 'created_at' | 'customer_snapshot'>,
  ext: 'pdf' | 'xlsx',
): PiFilename {
  const customer = sanitize(pi.customer_snapshot?.name ?? '')
  const seq = sequence(pi.pi_number)
  const base = [customer, 'PI', yyyymmdd(pi.created_at), seq]
    .filter(Boolean)
    .join(' ')
  const full = `${base}.${ext}`

  // ASCII fallback: drop non-ASCII (e.g. Chinese), collapse spaces, fall back to the PI number.
  const asciiBase = base.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim()
  const ascii = `${asciiBase || pi.pi_number}.${ext}`

  const encoded = encodeURIComponent(full)

  return { base, full, ascii, encoded }
}

/**
 * Assemble a Content-Disposition header value with RFC 5987 support.
 * Pass `inline` to render the file in-browser (used by the PDF preview iframe)
 * instead of forcing a download.
 */
export function contentDisposition(
  name: PiFilename,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  return `${disposition}; filename="${name.ascii}"; filename*=UTF-8''${name.encoded}`
}

/**
 * Build the default download filename for a weight calculation:
 *   标题 + " " + 计算单号 + " " + yyyyMMdd
 * e.g. 某客户 WC-2026-001 20260717.xlsx
 */
export function buildWeightCalcFilename(
  calc: { calc_number: string; title: string | null; created_at: string },
  ext: 'xlsx',
): PiFilename {
  const title = sanitize(calc.title ?? '')
  const base = [title || '重量计算', calc.calc_number, yyyymmdd(calc.created_at)]
    .filter(Boolean)
    .join(' ')
  const full = `${base}.${ext}`

  const asciiBase = base
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const ascii = `${asciiBase || calc.calc_number}.${ext}`

  const encoded = encodeURIComponent(full)

  return { base, full, ascii, encoded }
}
