'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireFinanceAccess } from '@/lib/auth'
import { chinaToday } from '@/lib/daily-order-costs-server'
import {
  isMergedBusinessDailyItemFullyPaid,
  isMergedBusinessDailyItemPaidAndShipped,
  mergeBusinessDailyItems,
  type BusinessDailyLedgerOrder,
} from '@/lib/business-daily-orders'
import {
  businessOrderItemCostOverrideSchema,
  businessOrderItemSettlementSchema,
  businessOrderItemUnsettleSchema,
  dailyOrderCostOverrideSchema,
  financeCostSchema,
  financeTransactionSchema,
} from '@/schemas/finance'
import type { ActionResult } from './products'
import type { CurrencyCode } from '@/types'

function revalidateFinance() {
  revalidatePath('/finance')
  revalidatePath('/finance/transactions')
  revalidatePath('/finance/costs')
  revalidatePath('/finance/performance')
}

function normalizedRate(currency: CurrencyCode, rate: number) {
  return currency === 'CNY' ? 1 : rate
}

export async function createFinanceTransaction(formData: FormData): Promise<ActionResult> {
  const profile = await requireFinanceAccess()
  const parsed = financeTransactionSchema.safeParse({
    transaction_type: formData.get('transaction_type'),
    category: formData.get('category'),
    transaction_date: formData.get('transaction_date'),
    amount_original: formData.get('amount_original'),
    currency: formData.get('currency'),
    exchange_rate_to_cny: formData.get('exchange_rate_to_cny'),
    finance_order_id: formData.get('finance_order_id'),
    salesperson_id: formData.get('salesperson_id'),
    reference_no: formData.get('reference_no') || '',
    description: formData.get('description') || '',
  })
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  let salespersonId = parsed.data.salesperson_id ?? null
  let salespersonName: string | null = null

  if (parsed.data.finance_order_id) {
    const { data: order, error: orderError } = await supabase
      .from('finance_orders')
      .select('salesperson_id, salesperson_name_snapshot')
      .eq('id', parsed.data.finance_order_id)
      .single()
    if (orderError || !order) return { ok: false, error: '关联订单不存在' }
    salespersonId = order.salesperson_id
    salespersonName = order.salesperson_name_snapshot
  } else if (salespersonId) {
    const { data: salesperson } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', salespersonId)
      .single()
    salespersonName = salesperson?.full_name || salesperson?.email || null
  }

  const { error } = await supabase.from('finance_transactions').insert({
    transaction_type: parsed.data.transaction_type,
    category: parsed.data.category,
    transaction_date: parsed.data.transaction_date,
    amount_original: parsed.data.amount_original,
    currency: parsed.data.currency,
    exchange_rate_to_cny: normalizedRate(
      parsed.data.currency,
      parsed.data.exchange_rate_to_cny,
    ),
    finance_order_id: parsed.data.finance_order_id ?? null,
    salesperson_id: salespersonId,
    salesperson_name_snapshot: salespersonName,
    reference_no: parsed.data.reference_no || null,
    description: parsed.data.description || null,
    created_by: profile.id,
  })
  if (error) return { ok: false, error: error.message }

  revalidateFinance()
  return { ok: true }
}

export async function createFinanceCost(formData: FormData): Promise<ActionResult> {
  const profile = await requireFinanceAccess()
  const parsed = financeCostSchema.safeParse({
    order_reference: formData.get('order_reference'),
    cost_type: formData.get('cost_type'),
    incurred_date: formData.get('incurred_date'),
    amount_original: formData.get('amount_original'),
    currency: formData.get('currency'),
    exchange_rate_to_cny: formData.get('exchange_rate_to_cny'),
    description: formData.get('description') || '',
  })
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const [source, orderId] = parsed.data.order_reference.split(':') as [
    'finance' | 'business',
    string,
  ]
  const supabase = await createClient()

  if (source === 'finance') {
    const { data: order, error: orderError } = await supabase
      .from('finance_orders')
      .select('id')
      .eq('id', orderId)
      .eq('status', 'active')
      .maybeSingle()
    if (orderError || !order) return { ok: false, error: '历史订单不存在或已作废' }
  } else {
    const { data: order, error: orderError } = await supabase
      .from('business_orders')
      .select('id')
      .eq('id', orderId)
      .in('status', ['approved', 'completed'])
      .maybeSingle()
    if (orderError || !order) return { ok: false, error: '业务订单不存在或尚未审核通过' }
  }

  const { error } = await supabase.from('finance_order_costs').insert({
    finance_order_id: source === 'finance' ? orderId : null,
    business_order_id: source === 'business' ? orderId : null,
    cost_type: parsed.data.cost_type,
    incurred_date: parsed.data.incurred_date,
    amount_original: parsed.data.amount_original,
    currency: parsed.data.currency,
    exchange_rate_to_cny: normalizedRate(
      parsed.data.currency,
      parsed.data.exchange_rate_to_cny,
    ),
    description: parsed.data.description || null,
    created_by: profile.id,
  })
  if (error) return { ok: false, error: error.message }

  revalidateFinance()
  return { ok: true }
}

export async function updateDailyOrderCostOverride(input: {
  daily_order_id: string
  cost: number | null
}): Promise<ActionResult> {
  const profile = await requireFinanceAccess()
  const parsed = dailyOrderCostOverrideSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  if (parsed.data.cost === null) {
    const { error } = await supabase
      .from('finance_daily_order_cost_overrides')
      .delete()
      .eq('daily_order_id', parsed.data.daily_order_id)
    if (error) return { ok: false, error: error.message }
    revalidatePath('/finance/costs')
    return { ok: true }
  }

  const { data: order, error: orderError } = await supabase
    .from('finance_daily_orders')
    .select('id')
    .eq('id', parsed.data.daily_order_id)
    .eq('status', 'active')
    .lte('shipping_date', chinaToday())
    .maybeSingle()
  if (orderError) return { ok: false, error: orderError.message }
  if (!order) return { ok: false, error: '订单行不存在、已作废或尚未发货' }

  const { error } = await supabase
    .from('finance_daily_order_cost_overrides')
    .upsert(
      {
        daily_order_id: parsed.data.daily_order_id,
        cost: parsed.data.cost,
        updated_by: profile.id,
      },
      { onConflict: 'daily_order_id' },
    )
  if (error) return { ok: false, error: error.message }

  revalidatePath('/finance/costs')
  return { ok: true }
}

export async function updateBusinessOrderItemCostOverride(input: {
  business_order_item_ids: string[]
  cost: number | null
}): Promise<ActionResult> {
  const profile = await requireFinanceAccess()
  const parsed = businessOrderItemCostOverrideSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const itemIds = parsed.data.business_order_item_ids

  if (parsed.data.cost === null) {
    const { error } = await supabase
      .from('finance_business_order_item_cost_overrides')
      .delete()
      .in('business_order_item_id', itemIds)
    if (error) return { ok: false, error: error.message }
    revalidatePath('/finance/costs')
    return { ok: true }
  }

  const { data: items, error: itemError } = await supabase
    .from('business_order_items')
    .select('id, order_id')
    .in('id', itemIds)
  if (itemError) return { ok: false, error: itemError.message }
  if (!items || items.length !== itemIds.length) {
    return { ok: false, error: '部分订单明细行不存在' }
  }

  const orderIds = new Set(items.map((item) => item.order_id))
  if (orderIds.size !== 1) {
    return { ok: false, error: '合并行的明细必须属于同一订单' }
  }
  const orderId = items[0].order_id

  const { data: order, error: orderError } = await supabase
    .from('business_orders')
    .select(
      'id, status, voided_at, business_order_items(*), business_order_shipments(*, business_order_shipment_items(*)), business_order_returns(*, business_order_return_items(*))',
    )
    .eq('id', orderId)
    .maybeSingle()
  if (orderError) return { ok: false, error: orderError.message }
  if (!order) return { ok: false, error: '订单不存在' }
  if (order.voided_at || !['approved', 'completed'].includes(order.status)) {
    return { ok: false, error: '只有已审核且未作废的订单才能修改成本' }
  }

  const selectedIds = new Set(itemIds)
  const mergedItem = mergeBusinessDailyItems(order as unknown as BusinessDailyLedgerOrder).find(
    (item) =>
      item.item_ids.length === selectedIds.size &&
      item.item_ids.every((id) => selectedIds.has(id)),
  )
  if (!mergedItem) return { ok: false, error: '所选明细不是完整的产品行' }
  if (!isMergedBusinessDailyItemPaidAndShipped(mergedItem)) {
    if (!isMergedBusinessDailyItemFullyPaid(mergedItem)) {
      return { ok: false, error: '产品行尚未收齐，不能修改成本' }
    }
    return { ok: false, error: '产品行尚未全部发货，不能修改成本' }
  }

  const rows = itemIds.map((id) => ({
    business_order_item_id: id,
    cost: parsed.data.cost,
    updated_by: profile.id,
  }))
  const { error } = await supabase
    .from('finance_business_order_item_cost_overrides')
    .upsert(rows, { onConflict: 'business_order_item_id' })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/finance/costs')
  return { ok: true }
}

function revalidateSettlement() {
  revalidatePath('/finance/costs')
  revalidatePath('/finance/settled-orders')
  revalidatePath('/finance/daily-orders')
}

export async function settleBusinessOrderItems(input: {
  business_order_item_ids: string[]
  period: string
}): Promise<ActionResult> {
  const profile = await requireFinanceAccess()
  const parsed = businessOrderItemSettlementSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const itemIds = parsed.data.business_order_item_ids
  const period = `${parsed.data.period}-01`

  const { data: items, error: itemError } = await supabase
    .from('business_order_items')
    .select('id, order_id, quantity, product_id, daily_shipping_category')
    .in('id', itemIds)
  if (itemError) return { ok: false, error: itemError.message }
  if (!items || items.length !== itemIds.length) {
    return { ok: false, error: '部分订单明细行不存在' }
  }

  const orderIds = [...new Set(items.map((item) => item.order_id))]

  const { data: orders, error: orderError } = await supabase
    .from('business_orders')
    .select(
      'id, status, voided_at, business_order_items(*), business_order_shipments(*, business_order_shipment_items(*)), business_order_returns(*, business_order_return_items(*))',
    )
    .in('id', orderIds)
  if (orderError) return { ok: false, error: orderError.message }
  const orderMap = new Map((orders ?? []).map((order) => [order.id, order]))

  for (const orderId of orderIds) {
    const order = orderMap.get(orderId)
    if (!order) return { ok: false, error: '订单不存在' }
    if (order.voided_at || !['approved', 'completed'].includes(order.status)) {
      return { ok: false, error: '只有已审核且未作废的订单才能结算' }
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
        return { ok: false, error: '结算必须包含完整的产品行' }
      }
      matchedItemCount += selectedItemCount
      if (!isMergedBusinessDailyItemPaidAndShipped(mergedItem)) {
        if (!isMergedBusinessDailyItemFullyPaid(mergedItem)) {
          return { ok: false, error: '存在未收齐的产品行，不能结算' }
        }
        return { ok: false, error: '存在未全部发货的产品行，不能结算' }
      }
    }
  }
  if (matchedItemCount !== itemIds.length) {
    return { ok: false, error: '部分订单明细未匹配到产品行' }
  }

  const { data: overrideRows, error: overrideError } = await supabase
    .from('finance_business_order_item_cost_overrides')
    .select('business_order_item_id, cost')
    .in('business_order_item_id', itemIds)
  if (overrideError) return { ok: false, error: overrideError.message }
  const overrides = new Map(
    (overrideRows ?? []).map((row) => [row.business_order_item_id, Number(row.cost)]),
  )

  const productIds = [...new Set(items.map((item) => item.product_id).filter(Boolean))] as string[]
  const catalog = new Map<string, number | null>()
  if (productIds.length > 0) {
    const { data: financialRows, error: financialError } = await supabase
      .from('product_financials')
      .select('product_id, cost')
      .in('product_id', productIds)
    if (financialError) return { ok: false, error: financialError.message }
    for (const row of financialRows ?? []) {
      catalog.set(row.product_id, row.cost == null ? null : Number(row.cost))
    }
  }

  const rows = items.map((item) => {
    const isCustom = item.daily_shipping_category === 'custom'
    const catalogCost = !isCustom && item.product_id ? catalog.get(item.product_id) ?? null : null
    const overrideCost = overrides.get(item.id)
    return {
      business_order_item_id: item.id,
      period,
      unit_cost: overrideCost ?? catalogCost,
      quantity: Number(item.quantity),
      settled_by: profile.id,
    }
  })

  const { error } = await supabase
    .from('finance_business_order_item_settlements')
    .upsert(rows, { onConflict: 'business_order_item_id' })
  if (error) return { ok: false, error: error.message }

  revalidateSettlement()
  return { ok: true }
}

export async function unsettleBusinessOrderItems(input: {
  business_order_item_ids: string[]
}): Promise<ActionResult> {
  await requireFinanceAccess()
  const parsed = businessOrderItemUnsettleSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('finance_business_order_item_settlements')
    .delete()
    .in('business_order_item_id', parsed.data.business_order_item_ids)
  if (error) return { ok: false, error: error.message }

  revalidateSettlement()
  return { ok: true }
}

export async function deleteFinanceTransaction(id: string): Promise<ActionResult> {
  await requireFinanceAccess()
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('finance_transactions')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: '收支记录不存在或无权删除' }
  revalidateFinance()
  return { ok: true }
}

export async function deleteFinanceCost(id: string): Promise<ActionResult> {
  await requireFinanceAccess()
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('finance_order_costs')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: '订单成本不存在或无权删除' }
  revalidateFinance()
  return { ok: true }
}
