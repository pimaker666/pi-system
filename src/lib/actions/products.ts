'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin, requireProfile } from '@/lib/auth'
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
    specification: formData.get('specification') || '',
    weight_g: formData.get('weight_g') ?? '',
    unit: formData.get('unit') || 'pcs',
    unit_price: formData.get('unit_price'),
    currency: formData.get('currency') || 'USD',
    image_url: formData.get('image_url') || '',
    category: formData.get('category') || '',
    group_id: formData.get('group_id') || '',
    is_active: formData.get('is_active') === 'on' || formData.get('is_active') === 'true',
  })
}

export async function createProduct(formData: FormData): Promise<ActionResult> {
  const profile = await requireProfile()
  const parsed = parseProduct(formData)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('products').insert({
    ...parsed.data,
    description: parsed.data.description || null,
    specification: parsed.data.specification || null,
    weight_g: parsed.data.weight_g ?? null,
    image_url: parsed.data.image_url || null,
    category: parsed.data.category || null,
    group_id: parsed.data.group_id || null,
    created_by: profile.id,
  })
  if (error) {
    return { ok: false, error: error.code === '23505' ? 'SKU 已存在' : error.message }
  }

  revalidatePath('/products')
  return { ok: true }
}

export async function updateProduct(id: string, formData: FormData): Promise<ActionResult> {
  await requireProfile()
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
      specification: parsed.data.specification || null,
      weight_g: parsed.data.weight_g ?? null,
      image_url: parsed.data.image_url || null,
      category: parsed.data.category || null,
      group_id: parsed.data.group_id || null,
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
  await requireProfile()
  const supabase = await createClient()
  const { error } = await supabase.from('products').update({ is_active: isActive }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/products')
  return { ok: true }
}

export async function bulkUpdateGroup(
  ids: string[],
  groupId: string | null,
): Promise<ActionResult> {
  await requireProfile()
  if (!ids.length) return { ok: false, error: '未选择任何产品' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('products')
    .update({ group_id: groupId || null })
    .in('id', ids)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/products')
  return { ok: true }
}

export async function bulkUpdatePrice(ids: string[], unitPrice: number): Promise<ActionResult> {
  await requireProfile()
  if (!ids.length) return { ok: false, error: '未选择任何产品' }
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    return { ok: false, error: '请输入有效的非负价格' }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('products')
    .update({ unit_price: unitPrice })
    .in('id', ids)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/products')
  return { ok: true }
}

export interface BulkProductPatch {
  currency?: string
  unit?: string
  category?: string
  specification?: string
}

const CURRENCY_CODES = ['USD', 'EUR', 'CNY', 'GBP', 'JPY']

/**
 * 批量修改选中产品的公共字段。仅更新填写了值的字段（留空即跳过）。
 */
export async function bulkUpdateProducts(
  ids: string[],
  patch: BulkProductPatch,
): Promise<ActionResult> {
  await requireProfile()
  if (!ids.length) return { ok: false, error: '未选择任何产品' }

  const update: Record<string, string> = {}
  if (patch.currency && CURRENCY_CODES.includes(patch.currency)) update.currency = patch.currency
  if (patch.unit && patch.unit.trim()) update.unit = patch.unit.trim()
  if (patch.category && patch.category.trim()) update.category = patch.category.trim()
  if (patch.specification && patch.specification.trim())
    update.specification = patch.specification.trim()

  if (Object.keys(update).length === 0) {
    return { ok: false, error: '请至少填写一个要修改的字段' }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('products').update(update).in('id', ids)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/products')
  return { ok: true }
}

export async function bulkDeleteProducts(ids: string[]): Promise<ActionResult> {
  await requireAdmin()
  if (!ids.length) return { ok: false, error: '未选择任何产品' }

  const supabase = await createClient()
  // pi_items.product_id is ON DELETE SET NULL, so历史 PI 快照不受影响。
  const { error } = await supabase.from('products').delete().in('id', ids)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/products')
  return { ok: true }
}

/**
 * 在产品库列表内联修改单个产品的「规格」或「克重」。
 * 传入 undefined 的字段不更新；specification 空字符串→null；weight 传 null 清空。
 */
export async function updateProductInline(
  id: string,
  patch: { specification?: string; weight_g?: number | null },
): Promise<ActionResult> {
  await requireProfile()

  const update: Record<string, string | number | null> = {}
  if (patch.specification !== undefined) {
    const spec = patch.specification.trim()
    if (spec.length > 200) return { ok: false, error: '规格过长（最多 200 字）' }
    update.specification = spec || null
  }
  if (patch.weight_g !== undefined) {
    if (patch.weight_g === null) {
      update.weight_g = null
    } else if (!Number.isFinite(patch.weight_g) || patch.weight_g < 0) {
      return { ok: false, error: '克重必须是非负数字' }
    } else {
      update.weight_g = patch.weight_g
    }
  }

  if (Object.keys(update).length === 0) {
    return { ok: false, error: '没有要更新的字段' }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('products').update(update).eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/products')
  return { ok: true }
}

export interface SaveVariantResult {
  ok: boolean
  error?: string
  /** 新（或已有）变体产品 id */
  id?: string
  /** 变体产品 SKU */
  sku?: string
}

/** 从 base SKU 出发，查询库里已有的 `BASE-n` 后缀，返回下一个可用 SKU（从 -2 开始）。 */
async function nextVariantSku(
  supabase: Awaited<ReturnType<typeof createClient>>,
  baseSku: string,
): Promise<string> {
  const { data } = await supabase
    .from('products')
    .select('sku')
    .like('sku', `${baseSku}-%`)

  let max = 1
  for (const row of data ?? []) {
    const rest = (row.sku as string).slice(baseSku.length + 1)
    if (/^\d+$/.test(rest)) {
      const n = Number(rest)
      if (n > max) max = n
    }
  }
  return `${baseSku}-${max + 1}`
}

/**
 * 开 PI 时替换了产品图片 → 自动把该行存为产品库中的新产品（SKU 自动加后缀）。
 * - 若该行之前已自动入库（existing_variant_id），则只更新那个变体产品的图片/名称/规格。
 * - 新产品继承源产品的单位、单价、币种、分类、分组、克重、描述；
 *   名称/规格使用行上当前值（用户改过就用改过的，没改就是源产品原值）。
 */
export async function saveImageVariantProduct(input: {
  source_product_id: string | null
  existing_variant_id?: string | null
  name: string
  specification: string | null
  image_url: string
}): Promise<SaveVariantResult> {
  const profile = await requireProfile()
  const supabase = await createClient()

  // 该行已经入过库：仅更新变体产品。
  if (input.existing_variant_id) {
    const { data, error } = await supabase
      .from('products')
      .update({
        image_url: input.image_url,
        name: input.name,
        specification: input.specification || null,
      })
      .eq('id', input.existing_variant_id)
      .select('id, sku')
      .maybeSingle()
    if (error) return { ok: false, error: error.message }
    if (data) return { ok: true, id: data.id, sku: data.sku }
    // 变体已被删除，退回新建流程。
  }

  if (!input.source_product_id) {
    return { ok: false, error: '找不到源产品，无法自动入库' }
  }

  const { data: source, error: srcErr } = await supabase
    .from('products')
    .select('*')
    .eq('id', input.source_product_id)
    .maybeSingle()
  if (srcErr) return { ok: false, error: srcErr.message }
  if (!source) return { ok: false, error: '源产品不存在，无法自动入库' }

  // SKU 冲突（并发/残留）时重算后缀，最多重试 5 次。
  for (let attempt = 0; attempt < 5; attempt++) {
    const sku = await nextVariantSku(supabase, source.sku)
    const { data, error } = await supabase
      .from('products')
      .insert({
        sku,
        name: input.name || source.name,
        description: source.description,
        specification: input.specification || null,
        weight_g: source.weight_g,
        unit: source.unit,
        unit_price: source.unit_price,
        currency: source.currency,
        image_url: input.image_url,
        category: source.category,
        group_id: source.group_id,
        is_active: true,
        created_by: profile.id,
      })
      .select('id, sku')
      .single()

    if (!error && data) {
      revalidatePath('/products')
      revalidatePath('/pi/create')
      return { ok: true, id: data.id, sku: data.sku }
    }
    if (error && error.code !== '23505') {
      return { ok: false, error: error.message }
    }
  }
  return { ok: false, error: 'SKU 冲突重试多次仍失败，请稍后再试' }
}

/**
 * 换图自动入库后，用户又在行上改了名称/规格 → 同步到那个变体产品。
 */
export async function syncVariantProductFields(
  variantId: string,
  patch: { name?: string; specification?: string | null },
): Promise<ActionResult> {
  await requireProfile()

  const update: Record<string, string | null> = {}
  if (patch.name !== undefined && patch.name.trim()) update.name = patch.name.trim()
  if (patch.specification !== undefined) {
    update.specification = patch.specification?.trim() || null
  }
  if (Object.keys(update).length === 0) return { ok: true }

  const supabase = await createClient()
  const { error } = await supabase.from('products').update(update).eq('id', variantId)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/products')
  return { ok: true }
}
