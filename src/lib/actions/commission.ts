'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin, requireApproved, requireFinanceAccess } from '@/lib/auth'
import {
  isMergedBusinessDailyItemFullyPaid,
  isMergedBusinessDailyItemPaidAndShipped,
  mergeBusinessDailyItems,
  type BusinessDailyLedgerOrder,
} from '@/lib/business-daily-orders'
import {
  businessOrderCommissionClearanceConfirmSchema,
  businessOrderCommissionClearanceRejectSchema,
  businessOrderCommissionClearanceSubmitSchema,
  businessOrderCommissionSchema,
  businessOrderItemCommissionSchema,
  commissionCategoryRateSchema,
  customerCommissionTagsSchema,
  customerCustomOrderCommissionRatesSchema,
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
  const { data: itemOrders, error: itemOrderError } = await supabase
    .from('business_order_items')
    .select('id, order:business_orders!inner(customer_id, voided_at)')
    .in('id', itemIds)
  if (itemOrderError) return { ok: false, error: itemOrderError.message }
  if (!itemOrders || itemOrders.length !== itemIds.length) {
    return { ok: false, error: '部分订单明细行不存在' }
  }
  const hasUncalculableOrder = itemOrders.some((item) => {
    const order = item.order as unknown as { customer_id: string | null; voided_at: string | null }
    return !order.customer_id || order.voided_at
  })
  if (hasUncalculableOrder) {
    return { ok: false, error: '请先为订单关联客户，再设置产品提点' }
  }

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
  settlement_exchange_rate_to_cny: number | null
}): Promise<ActionResult> {
  const profile = await requireApproved()
  const parsed = businessOrderCommissionSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { data: order, error: orderError } = await supabase
    .from('business_orders')
    .select('customer_id, voided_at')
    .eq('id', parsed.data.business_order_id)
    .maybeSingle()
  if (orderError) return { ok: false, error: orderError.message }
  if (!order || order.voided_at || !order.customer_id) {
    return { ok: false, error: '请先为订单关联客户，再设置运费提成' }
  }

  const { error } = await supabase.from('finance_business_order_commissions').upsert(
    {
      business_order_id: parsed.data.business_order_id,
      freight_cost: parsed.data.freight_cost,
      freight_commission_rate: parsed.data.freight_commission_rate,
      settlement_exchange_rate_to_cny: parsed.data.settlement_exchange_rate_to_cny,
      updated_by: profile.id,
    },
    { onConflict: 'business_order_id' },
  )
  if (error) return { ok: false, error: error.message }

  revalidateCommission()
  return { ok: true }
}

const commissionExchangeRateSchema = z.object({
  business_order_ids: z.array(z.string().uuid()).min(1),
  settlement_exchange_rate_to_cny: z.number().positive('汇率必须大于 0').max(1000, '汇率超出允许范围'),
})

export async function saveBusinessOrderCommissionExchangeRate(input: {
  business_order_ids: string[]
  settlement_exchange_rate_to_cny: number
}): Promise<ActionResult> {
  const profile = await requireApproved()
  const parsed = commissionExchangeRateSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { data: existing, error: selectError } = await supabase
    .from('finance_business_order_commissions')
    .select('business_order_id, freight_cost, freight_commission_rate')
    .in('business_order_id', parsed.data.business_order_ids)
  if (selectError) return { ok: false, error: selectError.message }

  const existingMap = new Map((existing ?? []).map((row) => [row.business_order_id, row]))
  const rows = parsed.data.business_order_ids.map((businessOrderId) => {
    const commission = existingMap.get(businessOrderId)
    return {
      business_order_id: businessOrderId,
      freight_cost: commission?.freight_cost ?? 0,
      freight_commission_rate: commission?.freight_commission_rate ?? 0,
      settlement_exchange_rate_to_cny: parsed.data.settlement_exchange_rate_to_cny,
      updated_by: profile.id,
    }
  })
  const { error } = await supabase
    .from('finance_business_order_commissions')
    .upsert(rows, { onConflict: 'business_order_id' })
  if (error) return { ok: false, error: error.message }

  revalidateCommission()
  revalidatePath('/finance/profit')
  revalidatePath('/finance/performance')
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

const customOrderRatesInput = z.object({ rates: customerCustomOrderCommissionRatesSchema })

export async function saveCustomerCustomOrderCommissionRates(input: {
  rates: Array<{ maximum_custom_order_count: number; product_commission_rate: number }>
}): Promise<ActionResult> {
  const profile = await requireFinanceAccess()
  const parsed = customOrderRatesInput.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { error: deleteError } = await supabase
    .from('finance_customer_custom_order_commission_rates')
    .delete()
    .gte('maximum_custom_order_count', 0)
  if (deleteError) return { ok: false, error: deleteError.message }

  if (parsed.data.rates.length > 0) {
    const { error } = await supabase.from('finance_customer_custom_order_commission_rates').insert(
      parsed.data.rates.map((rate) => ({ ...rate, updated_by: profile.id })),
    )
    if (error) return { ok: false, error: error.message }
  }

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

function revalidateClearance() {
  revalidateCommission()
  revalidatePath('/finance/commission/settled')
  revalidatePath('/finance/my-commission')
  revalidatePath('/finance/daily-orders')
}

function clearancePeriodToDate(period: string): string {
  return `${period}-01`
}

export async function submitBusinessOrderCommissionClearance(input: {
  business_order_item_ids: string[]
  period: string
}): Promise<ActionResult> {
  const profile = await requireFinanceAccess()
  const parsed = businessOrderCommissionClearanceSubmitSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const itemIds = parsed.data.business_order_item_ids

  const { data: items, error: itemError } = await supabase
    .from('business_order_items')
    .select('id, order_id')
    .in('id', itemIds)
  if (itemError) return { ok: false, error: itemError.message }
  if (!items || items.length !== itemIds.length) {
    return { ok: false, error: '部分订单明细行不存在' }
  }

  const orderIds = [...new Set(items.map((item) => item.order_id))]
  const { data: orders, error: orderError } = await supabase
    .from('business_orders')
    .select(
      'id, status, voided_at, salesperson_id, customer_id, business_order_items(*), business_order_shipments(*, business_order_shipment_items(*)), business_order_returns(*, business_order_return_items(*)), business_order_payment_allocations(order_item_id, allocation_target, amount, voided_at, transfer:business_customer_transfers(voided_at))',
    )
    .in('id', orderIds)
  if (orderError) return { ok: false, error: orderError.message }

  const orderMap = new Map((orders ?? []).map((order) => [order.id, order]))
  for (const orderId of orderIds) {
    const order = orderMap.get(orderId)
    if (!order) return { ok: false, error: '订单不存在' }
    if (order.voided_at || !['approved', 'completed'].includes(order.status)) {
      return { ok: false, error: '只有已审核且未作废的订单才能提交提成结清' }
    }
    if (!order.customer_id) {
      return { ok: false, error: '请先为订单关联客户，再提交提成结清' }
    }
  }

  const selectedIds = new Set(itemIds)
  let matchedItemCount = 0
  for (const orderId of orderIds) {
    const order = orderMap.get(orderId) as unknown as BusinessDailyLedgerOrder
    for (const mergedItem of mergeBusinessDailyItems(order)) {
      const selectedItemCount = mergedItem.item_ids.filter((id) => selectedIds.has(id)).length
      if (selectedItemCount === 0) continue
      if (selectedItemCount !== mergedItem.item_ids.length) {
        return { ok: false, error: '提交结清必须包含完整的产品行' }
      }
      matchedItemCount += selectedItemCount
      if (!isMergedBusinessDailyItemPaidAndShipped(mergedItem)) {
        if (!isMergedBusinessDailyItemFullyPaid(mergedItem)) {
          return { ok: false, error: '存在未收齐的产品行，不能提交提成结清' }
        }
        return { ok: false, error: '存在未全部发货的产品行，不能提交提成结清' }
      }
    }
  }
  if (matchedItemCount !== itemIds.length) {
    return { ok: false, error: '部分订单明细未匹配到产品行' }
  }

  const periodDate = clearancePeriodToDate(parsed.data.period)
  const rows = itemIds.map((id) => ({
    business_order_item_id: id,
    period: periodDate,
    status: 'pending' as const,
    submitted_by: profile.id,
    submitted_at: new Date().toISOString(),
    confirmed_by: null,
    confirmed_at: null,
    rejected_reason: null,
  }))

  const { error } = await supabase
    .from('finance_business_order_item_commission_clearances')
    .upsert(rows, { onConflict: 'business_order_item_id' })
  if (error) return { ok: false, error: error.message }

  revalidateClearance()
  return { ok: true }
}

async function assertClearanceActorPermission(
  supabase: Awaited<ReturnType<typeof createClient>>,
  itemIds: string[],
  profile: { id: string; role: string },
): Promise<ActionResult | null> {
  const isFinanceOrAdmin = profile.role === 'admin' || profile.role === 'finance'
  if (isFinanceOrAdmin) return null

  const { data: items, error: itemError } = await supabase
    .from('business_order_items')
    .select('id, order_id')
    .in('id', itemIds)
  if (itemError) return { ok: false, error: itemError.message }
  if (!items || items.length !== itemIds.length) {
    return { ok: false, error: '部分订单明细行不存在' }
  }

  const orderIds = [...new Set(items.map((item) => item.order_id))]
  const { data: orders, error: orderError } = await supabase
    .from('business_orders')
    .select('id, salesperson_id')
    .in('id', orderIds)
  if (orderError) return { ok: false, error: orderError.message }

  const orderSalespeople = new Map((orders ?? []).map((order) => [order.id, order.salesperson_id]))
  for (const item of items) {
    if (orderSalespeople.get(item.order_id) !== profile.id) {
      return { ok: false, error: '只能处理自己订单的提成结清' }
    }
  }
  return null
}

export async function confirmBusinessOrderCommissionClearance(input: {
  business_order_item_ids: string[]
}): Promise<ActionResult> {
  const profile = await requireApproved()
  const parsed = businessOrderCommissionClearanceConfirmSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const itemIds = parsed.data.business_order_item_ids

  const { data: rows, error: selectError } = await supabase
    .from('finance_business_order_item_commission_clearances')
    .select('business_order_item_id, status')
    .in('business_order_item_id', itemIds)
    .eq('status', 'pending')
  if (selectError) return { ok: false, error: selectError.message }
  if (!rows || rows.length !== itemIds.length) {
    return { ok: false, error: '部分提成结清记录不存在或已处理' }
  }

  const permissionError = await assertClearanceActorPermission(supabase, itemIds, profile)
  if (permissionError) return permissionError

  const { error } = await supabase
    .from('finance_business_order_item_commission_clearances')
    .update({
      status: 'confirmed',
      confirmed_by: profile.id,
      confirmed_at: new Date().toISOString(),
      rejected_reason: null,
    })
    .in('business_order_item_id', itemIds)
    .eq('status', 'pending')
  if (error) return { ok: false, error: error.message }

  revalidateClearance()
  return { ok: true }
}

export async function rejectBusinessOrderCommissionClearance(input: {
  business_order_item_ids: string[]
  reason: string
}): Promise<ActionResult> {
  const profile = await requireApproved()
  const parsed = businessOrderCommissionClearanceRejectSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const itemIds = parsed.data.business_order_item_ids

  const { data: rows, error: selectError } = await supabase
    .from('finance_business_order_item_commission_clearances')
    .select('business_order_item_id, status')
    .in('business_order_item_id', itemIds)
    .eq('status', 'pending')
  if (selectError) return { ok: false, error: selectError.message }
  if (!rows || rows.length !== itemIds.length) {
    return { ok: false, error: '部分提成结清记录不存在或已处理' }
  }

  const permissionError = await assertClearanceActorPermission(supabase, itemIds, profile)
  if (permissionError) return permissionError

  const { error } = await supabase
    .from('finance_business_order_item_commission_clearances')
    .update({
      status: 'rejected',
      rejected_reason: parsed.data.reason,
      confirmed_by: null,
      confirmed_at: null,
    })
    .in('business_order_item_id', itemIds)
    .eq('status', 'pending')
  if (error) return { ok: false, error: error.message }

  revalidateClearance()
  return { ok: true }
}
