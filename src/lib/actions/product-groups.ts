'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireProfile } from '@/lib/auth'
import { productGroupSchema } from '@/schemas/product'
import type { ActionResult } from './products'

function parseGroup(formData: FormData) {
  return productGroupSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') || '',
  })
}

export async function createProductGroup(formData: FormData): Promise<ActionResult> {
  const profile = await requireProfile()
  const parsed = parseGroup(formData)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { data: maxRow } = await supabase
    .from('product_groups')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextOrder = (maxRow?.sort_order ?? -1) + 1

  const { error } = await supabase.from('product_groups').insert({
    name: parsed.data.name,
    description: parsed.data.description || null,
    sort_order: nextOrder,
    created_by: profile.id,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/products/groups')
  revalidatePath('/products')
  return { ok: true }
}

export async function updateProductGroup(id: string, formData: FormData): Promise<ActionResult> {
  await requireProfile()
  const parsed = parseGroup(formData)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('product_groups')
    .update({ name: parsed.data.name, description: parsed.data.description || null })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/products/groups')
  return { ok: true }
}

export async function deleteProductGroup(id: string): Promise<ActionResult> {
  await requireProfile()
  const supabase = await createClient()
  // products.group_id is ON DELETE SET NULL, so members become ungrouped.
  const { error } = await supabase.from('product_groups').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/products/groups')
  revalidatePath('/products')
  return { ok: true }
}

export async function reorderProductGroups(orderedIds: string[]): Promise<ActionResult> {
  await requireProfile()
  if (!orderedIds.length) return { ok: false, error: '没有可排序的分组' }

  const supabase = await createClient()
  // Persist each group's position as its sort_order (index in the array).
  const results = await Promise.all(
    orderedIds.map((id, index) =>
      supabase.from('product_groups').update({ sort_order: index }).eq('id', id),
    ),
  )
  const failed = results.find((r) => r.error)
  if (failed?.error) return { ok: false, error: failed.error.message }

  revalidatePath('/products/groups')
  revalidatePath('/products')
  return { ok: true }
}
