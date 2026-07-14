'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth'
import { productSchema } from '@/schemas/product'

export interface ActionResult {
  ok: boolean
  error?: string
  fieldErrors?: Record<string, string[]>
}

function parseProduct(formData: FormData) {
  return productSchema.safeParse({
    sku: formData.get('sku'),
    name: formData.get('name'),
    description: formData.get('description') || '',
    unit: formData.get('unit') || 'pcs',
    unit_price: formData.get('unit_price'),
    currency: formData.get('currency') || 'USD',
    image_url: formData.get('image_url') || '',
    is_active: formData.get('is_active') === 'on' || formData.get('is_active') === 'true',
  })
}

export async function createProduct(formData: FormData): Promise<ActionResult> {
  await requireAdmin()
  const parsed = parseProduct(formData)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('products').insert({
    ...parsed.data,
    description: parsed.data.description || null,
    image_url: parsed.data.image_url || null,
  })
  if (error) {
    return { ok: false, error: error.code === '23505' ? 'SKU 已存在' : error.message }
  }

  revalidatePath('/products')
  return { ok: true }
}

export async function updateProduct(id: string, formData: FormData): Promise<ActionResult> {
  await requireAdmin()
  const parsed = parseProduct(formData)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('products')
    .update({
      ...parsed.data,
      description: parsed.data.description || null,
      image_url: parsed.data.image_url || null,
    })
    .eq('id', id)
  if (error) {
    return { ok: false, error: error.code === '23505' ? 'SKU 已存在' : error.message }
  }

  revalidatePath('/products')
  revalidatePath(`/products/${id}/edit`)
  return { ok: true }
}

export async function toggleProductActive(id: string, isActive: boolean): Promise<ActionResult> {
  await requireAdmin()
  const supabase = await createClient()
  const { error } = await supabase.from('products').update({ is_active: isActive }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/products')
  return { ok: true }
}
