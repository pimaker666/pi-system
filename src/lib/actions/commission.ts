'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin, requireApproved, requireFinanceAccess } from '@/lib/auth'
import {
  businessOrderCommissionSchema,
  businessOrderItemCommissionSchema,
  commissionCategoryRateSchema,
  customerCommissionTagsSchema,
} from '@/schemas/business-order-commission'
import type { ActionResult } from './products'

function revalidateCommission() {
  revalidatePath('/finance/commission')
}

export async function saveBusinessOrderItemCommission(input: {
  business_order_item_ids: string[]
  rate: number | null
}): Promise<ActionResult> {
  const profile = await requireApproved()
  const parsed = businessOrderItemCommissionSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const itemIds = parsed.data.business_order_item_ids

  if (parsed.data.rate === null) {
    const { error } = await supabase
      .from('finance_business_order_item_commissions')
      .delete()
      .in('business_order_item_id', itemIds)
    if (error) return { ok: false, error: error.message }
    revalidateCommission()
    return { ok: true }
  }

  const rows = itemIds.map((id) => ({
    business_order_item_id: id,
    commission_rate: parsed.data.rate,
    updated_by: profile.id,
  }))
  const { error } = await supabase
    .from('finance_business_order_item_commissions')
    .upsert(rows, { onConflict: 'business_order_item_id' })
  if (error) return { ok: false, error: error.message }

  revalidateCommission()
  return { ok: true }
}

export async function saveBusinessOrderCommission(input: {
  business_order_id: string
  freight_cost: number
  freight_commission_rate: number
}): Promise<ActionResult> {
  const profile = await requireApproved()
  const parsed = businessOrderCommissionSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('finance_business_order_commissions').upsert(
    {
      business_order_id: parsed.data.business_order_id,
      freight_cost: parsed.data.freight_cost,
      freight_commission_rate: parsed.data.freight_commission_rate,
      updated_by: profile.id,
    },
    { onConflict: 'business_order_id' },
  )
  if (error) return { ok: false, error: error.message }

  revalidateCommission()
  return { ok: true }
}

const categoryRatesInput = z.object({
  rates: z.array(commissionCategoryRateSchema).min(1, '至少设置一个发货分类'),
})

export async function saveCommissionCategoryRates(input: {
  rates: Array<{ category: string; product_commission_rate: number }>
}): Promise<ActionResult> {
  const profile = await requireFinanceAccess()
  const parsed = categoryRatesInput.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const rows = parsed.data.rates.map((row) => ({
    category: row.category,
    product_commission_rate: row.product_commission_rate,
    updated_by: profile.id,
  }))
  const { error } = await supabase
    .from('finance_commission_category_rates')
    .upsert(rows, { onConflict: 'category' })
  if (error) return { ok: false, error: error.message }

  revalidateCommission()
  return { ok: true }
}

const customerTagsInput = z.object({ tags: customerCommissionTagsSchema })

export async function saveCustomerCommissionTags(input: {
  tags: Array<{ tag_color: string; label: string; product_commission_rate: number; sort_order?: number }>
}): Promise<ActionResult> {
  const profile = await requireAdmin()
  const parsed = customerTagsInput.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const tags = parsed.data.tags

  // 小规模管理表（≤50 行），整表替换：先清空再插入，避免残留已删除的标记。
  const { error: deleteError } = await supabase
    .from('finance_customer_commission_tags')
    .delete()
    .gte('created_at', '1970-01-01')
  if (deleteError) return { ok: false, error: deleteError.message }

  if (tags.length > 0) {
    const rows = tags.map((tag, index) => ({
      tag_color: tag.tag_color,
      label: tag.label,
      product_commission_rate: tag.product_commission_rate,
      sort_order: tag.sort_order ?? index,
      updated_by: profile.id,
    }))
    const { error } = await supabase.from('finance_customer_commission_tags').insert(rows)
    if (error) return { ok: false, error: error.message }
  }

  revalidateCommission()
  revalidatePath('/customers')
  return { ok: true }
}
