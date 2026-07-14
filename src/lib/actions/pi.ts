'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireProfile } from '@/lib/auth'
import { createPiSchema } from '@/schemas/pi'
import { calcPiTotals, calcLineTotal } from '@/lib/calc'
import type { ActionResult } from './products'

const PDF_BUCKET = 'pi-pdfs'

export interface CreatePiResult extends ActionResult {
  id?: string
  pi_number?: string
}

/**
 * Create a Proforma Invoice atomically via the `create_pi_with_items` RPC.
 * Amounts are recalculated on the server — never trust client totals.
 */
export async function createProformaInvoice(rawInput: unknown): Promise<CreatePiResult> {
  await requireProfile()

  const parsed = createPiSchema.safeParse(rawInput)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? '数据校验失败' }
  }
  const input = parsed.data

  // Server-side recomputation of every monetary value.
  const totals = calcPiTotals(
    input.items.map((i) => ({
      product_id: i.product_id,
      sku: i.sku,
      name: i.name,
      description: i.description ?? null,
      unit: i.unit,
      unit_price: i.unit_price,
      currency: input.currency,
      quantity: i.quantity,
    })),
    input.charges,
  )

  const itemsPayload = input.items.map((i, idx) => ({
    product_id: i.product_id,
    sku: i.sku,
    name: i.name,
    description: i.description ?? null,
    unit: i.unit,
    unit_price: i.unit_price,
    quantity: i.quantity,
    line_total: calcLineTotal(i.unit_price, i.quantity),
    sort_order: idx,
  }))

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('create_pi_with_items', {
    p_customer_id: input.customer_id ?? null,
    p_customer_snapshot: input.customer_snapshot,
    p_currency: input.currency,
    p_subtotal: totals.subtotal,
    p_tax_rate: input.charges.tax_rate,
    p_tax_amount: totals.tax_amount,
    p_shipping_fee: input.charges.shipping_fee,
    p_discount: input.charges.discount,
    p_total: totals.total,
    p_notes: input.notes || null,
    p_terms: input.terms || null,
    p_items: itemsPayload,
  })

  if (error) {
    return { ok: false, error: error.message }
  }

  const pi = Array.isArray(data) ? data[0] : data
  revalidatePath('/pi/history')
  revalidatePath('/dashboard')
  return { ok: true, id: pi.id, pi_number: pi.pi_number }
}

/**
 * Return a short-lived signed URL for the PI's stored PDF in the private bucket.
 * If no PDF has been persisted yet, callers should fall back to the on-demand
 * /api/pi/[id]/pdf route.
 */
export async function getPiDownloadUrl(id: string): Promise<{ url?: string; error?: string }> {
  await requireProfile()
  const supabase = await createClient()

  const { data: pi, error } = await supabase
    .from('proforma_invoices')
    .select('pdf_path')
    .eq('id', id)
    .single()
  if (error) return { error: error.message }
  if (!pi?.pdf_path) return { error: 'PDF 尚未生成' }

  const admin = createAdminClient()
  const { data: signed, error: signError } = await admin.storage
    .from(PDF_BUCKET)
    .createSignedUrl(pi.pdf_path, 60 * 10)
  if (signError) return { error: signError.message }

  return { url: signed.signedUrl }
}

export async function voidProformaInvoice(id: string): Promise<ActionResult> {
  await requireProfile()
  const supabase = await createClient()
  const { error } = await supabase
    .from('proforma_invoices')
    .update({ status: 'void' })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/pi/history')
  revalidatePath(`/pi/${id}`)
  return { ok: true }
}
