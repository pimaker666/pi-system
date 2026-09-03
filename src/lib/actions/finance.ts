'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireFinanceAccess } from '@/lib/auth'
import { financeCostSchema, financeTransactionSchema } from '@/schemas/finance'
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
