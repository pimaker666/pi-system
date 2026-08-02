'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireProfile } from '@/lib/auth'
import { createPiSchema } from '@/schemas/pi'
import { calcPiTotals, calcLineTotal } from '@/lib/calc'
import type { ProformaInvoiceWithItems } from '@/types'
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

  const supabase = await createClient()

  // Guard against stale client carts. The PI cart is persisted in the browser
  // (localStorage), so a line item may carry a product_id whose product row has
  // since been deleted or re-seeded. pi_items snapshots sku/name/image/spec and
  // product_id is nullable, so we simply drop any product_id that no longer
  // exists to avoid an FK violation (pi_items_product_id_fkey) on insert.
  const candidateIds = Array.from(
    new Set(
      input.items
        .map((i) => i.product_id)
        .filter((v): v is string => typeof v === 'string' && v.length > 0),
    ),
  )
  let existingIds = new Set<string>()
  if (candidateIds.length) {
    const { data: existing } = await supabase
      .from('products')
      .select('id')
      .in('id', candidateIds)
    existingIds = new Set((existing ?? []).map((r) => r.id as string))
  }
  const resolveProductId = (id: string | null | undefined) =>
    id && existingIds.has(id) ? id : null

  // Server-side recomputation of every monetary value.
  const totals = calcPiTotals(
    input.items.map((i) => ({
      product_id: resolveProductId(i.product_id),
      sku: i.sku,
      name: i.name,
      description: i.description ?? null,
      image_url: i.image_url ?? null,
      remark_image_url: i.remark_image_url ?? null,
      specification: i.specification ?? null,
      weight_g: i.weight_g ?? null,
      unit: i.unit,
      unit_price: i.unit_price,
      currency: input.currency,
      quantity: i.quantity,
    })),
    input.charges,
  )

  const itemsPayload = input.items.map((i, idx) => ({
    product_id: resolveProductId(i.product_id),
    sku: i.sku,
    name: i.name,
    description: i.description ?? null,
    image_url: i.image_url ?? null,
    remark_image_url: i.remark_image_url ?? null,
    specification: i.specification ?? null,
    weight_g: i.weight_g ?? null,
    unit: i.unit,
    unit_price: i.unit_price,
    quantity: i.quantity,
    line_total: calcLineTotal(i.unit_price, i.quantity),
    sort_order: idx,
  }))

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
    p_shipping_method: input.shipping_method || null,
    p_show_specification: input.show_specification,
    p_show_weight: input.show_weight,
  })

  if (error) {
    return { ok: false, error: error.message }
  }

  const pi = Array.isArray(data) ? data[0] : data

  // Snapshot the account's active company profile (fallback: global settings)
  // so the PI keeps the company info chosen at creation time.
  const COMPANY_FIELDS = [
    'company_name',
    'address',
    'phone',
    'email',
    'website',
    'logo_url',
    'accent_color',
    'bank_name',
    'bank_account',
    'bank_swift',
    'bank_address',
    'default_terms',
  ] as const
  const { data: activeProfile } = await supabase
    .from('company_profiles')
    .select(COMPANY_FIELDS.join(','))
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()
  const source =
    activeProfile ??
    (
      await supabase
        .from('company_settings')
        .select(COMPANY_FIELDS.join(','))
        .eq('id', 1)
        .maybeSingle()
    ).data
  if (source) {
    const snapshot = Object.fromEntries(
      COMPANY_FIELDS.map((k) => [k, (source as unknown as Record<string, unknown>)[k] ?? null]),
    )
    await supabase
      .from('proforma_invoices')
      .update({ company_snapshot: snapshot })
      .eq('id', pi.id)
  }

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

/**
 * Soft-delete PIs (move to recycle bin). RLS limits the update to the caller's
 * own PIs (or all, for admins).
 */
export async function bulkSoftDeletePi(ids: string[]): Promise<ActionResult> {
  await requireProfile()
  if (ids.length === 0) return { ok: false, error: '未选择任何 PI' }
  const supabase = await createClient()
  const { error } = await supabase
    .from('proforma_invoices')
    .update({ deleted_at: new Date().toISOString() })
    .in('id', ids)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/pi/history')
  revalidatePath('/dashboard')
  return { ok: true }
}

/** Restore PIs from the recycle bin. */
export async function restorePi(ids: string[]): Promise<ActionResult> {
  await requireProfile()
  if (ids.length === 0) return { ok: false, error: '未选择任何 PI' }
  const supabase = await createClient()
  const { error } = await supabase
    .from('proforma_invoices')
    .update({ deleted_at: null })
    .in('id', ids)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/pi/history')
  revalidatePath('/dashboard')
  return { ok: true }
}

/** Permanently delete PIs from the recycle bin (irreversible). */
export async function purgePi(ids: string[]): Promise<ActionResult> {
  await requireProfile()
  if (ids.length === 0) return { ok: false, error: '未选择任何 PI' }
  const supabase = await createClient()
  const { error } = await supabase
    .from('proforma_invoices')
    .delete()
    .in('id', ids)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/pi/history')
  return { ok: true }
}

/** Toggle the current account's favorite state for a PI. */
export async function toggleFavorite(
  piId: string,
  favorite: boolean,
): Promise<ActionResult> {
  const profile = await requireProfile()
  const supabase = await createClient()

  if (favorite) {
    const { error } = await supabase
      .from('pi_favorites')
      .upsert({ user_id: profile.id, pi_id: piId }, { onConflict: 'user_id,pi_id' })
    if (error) return { ok: false, error: error.message }
  } else {
    const { error } = await supabase
      .from('pi_favorites')
      .delete()
      .eq('user_id', profile.id)
      .eq('pi_id', piId)
    if (error) return { ok: false, error: error.message }
  }

  revalidatePath('/pi/history')
  return { ok: true }
}

/** Load a full PI (with items) for cloning into the create page. */
export async function getPiForClone(id: string): Promise<ProformaInvoiceWithItems | null> {
  await requireProfile()
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('proforma_invoices')
    .select('*, pi_items(*)')
    .eq('id', id)
    .single()
  if (error || !data) return null
  return data as ProformaInvoiceWithItems
}
