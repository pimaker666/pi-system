'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireProfile } from '@/lib/auth'
import {
  createWeightCalcSchema,
  type CreateWeightCalcInput,
} from '@/schemas/weight'
import type { WeightCalcLineItem } from '@/types'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(s?: string | null): s is string {
  return !!s && UUID_RE.test(s)
}

/**
 * Fetch a PI's line items and map them into weight-calculation rows.
 * Used by the "计算重量" window to auto-generate a table from an existing PI.
 * Each row carries the item's weight snapshot (weight_g) and quantity so the
 * client can compute total weight in KG. When a PI predates the weight feature
 * (its snapshot weight_g is null), we fall back to the product's current
 * weight_g so imported rows still show a usable value.
 */
export async function getPiItemsForWeight(
  piId: string,
): Promise<WeightCalcLineItem[]> {
  await requireProfile()
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('proforma_invoices')
    .select(
      'id, pi_items(product_id, sku, name, image_url, weight_g, quantity, sort_order, product:products(weight_g))',
    )
    .eq('id', piId)
    .single()

  if (error || !data) return []

  const items = (data.pi_items ?? []) as unknown as Array<{
    product_id: string | null
    sku: string | null
    name: string
    image_url: string | null
    weight_g: number | null
    quantity: number | null
    sort_order: number
    // supabase-js types an embedded to-one relation as an array; normalize below.
    product: { weight_g: number | null } | { weight_g: number | null }[] | null
  }>

  return [...items]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((it, idx) => {
      const product = Array.isArray(it.product) ? it.product[0] : it.product
      return {
        // Deleted products keep a null product_id; use a stable synthetic key.
        product_id: it.product_id ?? `pi-${idx}-${it.sku ?? 'item'}`,
        sku: it.sku,
        name: it.name,
        image_url: it.image_url,
        // Prefer the PI row snapshot; fall back to the product's current weight.
        weight_g: it.weight_g ?? product?.weight_g ?? null,
        quantity: it.quantity ?? null,
      }
    })
}

/**
 * Persist a weight calculation and its line items atomically via the
 * create_weight_calc_with_items RPC. Totals are computed server-side from the
 * (sanitized) items so the stored figures can't be tampered with. Synthetic
 * product ids (from deleted-product PI rows) are stripped to empty so the RPC's
 * nullif casts them to null (the column is a real uuid FK).
 */
export async function createWeightCalc(
  input: CreateWeightCalcInput,
): Promise<{ id: string; calc_number: string }> {
  await requireProfile()
  const parsed = createWeightCalcSchema.parse(input)
  const supabase = await createClient()

  let totalQty = 0
  let totalWeightG = 0
  const items = parsed.items.map((it, idx) => {
    const w = Number(it.weight_g) || 0
    const q = Number(it.quantity) || 0
    const line = w * q
    totalQty += q
    totalWeightG += line
    return {
      product_id: isUuid(it.product_id) ? it.product_id : '',
      sku: it.sku ?? '',
      name: it.name,
      image_url: it.image_url ?? '',
      weight_g: w,
      quantity: q,
      line_weight_g: line,
      sort_order: idx,
    }
  })

  const { data, error } = await supabase.rpc('create_weight_calc_with_items', {
    p_title: parsed.title ?? '',
    p_source_pi_id: isUuid(parsed.source_pi_id) ? parsed.source_pi_id : null,
    p_total_quantity: totalQty,
    p_total_weight_g: totalWeightG,
    p_items: items,
  })

  if (error) throw new Error(error.message)
  const row = (Array.isArray(data) ? data[0] : data) as {
    id: string
    calc_number: string
  }
  revalidatePath('/pi/history')
  return { id: row.id, calc_number: row.calc_number }
}

/** Delete a weight calculation; items cascade via FK. RLS-scoped to owner/admin. */
export async function deleteWeightCalc(id: string): Promise<void> {
  await requireProfile()
  const supabase = await createClient()
  const { error } = await supabase
    .from('weight_calculations')
    .delete()
    .eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/pi/history')
}
