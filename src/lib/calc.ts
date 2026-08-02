import type { PiLineItem, PiCharges, PiTotals } from '@/types'

/** Minimal fields calcPiTotals needs from a line. */
export type PiTotalsLine = Pick<PiLineItem, 'unit_price' | 'quantity'>

/** Round to 2 decimal places avoiding float drift. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function calcLineTotal(
  unitPrice: number | null,
  quantity: number | null,
): number {
  return round2((unitPrice ?? 0) * (quantity ?? 0))
}

/**
 * Simple mode totals:
 *   subtotal   = Σ line totals
 *   tax_amount = (subtotal - discount) * tax_rate%
 *   total      = subtotal - discount + tax_amount + shipping_fee
 */
export function calcPiTotals(items: PiTotalsLine[], charges: PiCharges): PiTotals {
  const subtotal = round2(
    items.reduce((sum, item) => sum + calcLineTotal(item.unit_price, item.quantity), 0),
  )
  const discount = round2(Math.min(charges.discount ?? 0, subtotal))
  const taxable = round2(subtotal - discount)
  const tax_amount = round2(taxable * ((charges.tax_rate ?? 0) / 100))
  const total = round2(taxable + tax_amount + (charges.shipping_fee ?? 0))
  return { subtotal, tax_amount, total }
}
