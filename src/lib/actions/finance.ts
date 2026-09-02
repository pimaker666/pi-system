'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireApproved, requireFinanceAccess } from '@/lib/auth'
import {
  financeCostSchema,
  financeOrderSchema,
  financeTransactionSchema,
} from '@/schemas/finance'
import type { ActionResult } from './products'
import type { CurrencyCode } from '@/types'

interface PiForFinance {
  id: string
  pi_number: string
  customer_snapshot: { name?: string; company?: string } | null
  total: number
  currency: CurrencyCode
  created_by: string | null
  created_at: string
  status: 'active' | 'void'
  deleted_at: string | null
}

function revalidateFinance() {
  revalidatePath('/finance')
  revalidatePath('/finance/transactions')
  revalidatePath('/finance/costs')
  revalidatePath('/finance/performance')
}

function normalizedRate(currency: CurrencyCode, rate: number) {
  return currency === 'CNY' ? 1 : rate
}

export async function createFinanceOrder(
  formData: FormData,
): Promise<ActionResult & { id?: string }> {
  const profile = await requireApproved()
  const parsed = financeOrderSchema.safeParse({
    pi_id: formData.get('pi_id'),
    exchange_rate_to_cny: formData.get('exchange_rate_to_cny'),
    order_date: formData.get('order_date'),
    notes: formData.get('notes') || '',
  })
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('proforma_invoices')
    .select('id, pi_number, customer_snapshot, total, currency, created_by, created_at, status, deleted_at')
    .eq('id', parsed.data.pi_id)
    .single()

  if (error || !data) return { ok: false, error: 'PI 不存在或无权访问' }
  const pi = data as PiForFinance
  if (pi.status !== 'active' || pi.deleted_at) {
    return { ok: false, error: '已作废或已删除的 PI 不能登记业绩' }
  }
  if (!pi.created_by) return { ok: false, error: '该 PI 没有业务员归属，请先补充归属' }
  if (profile.role === 'sales' && pi.created_by !== profile.id) {
    return { ok: false, error: '只能登记自己名下的 PI' }
  }

  const { data: salesperson } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', pi.created_by)
    .single()

  const customer = pi.customer_snapshot ?? {}
  const customerName = customer.company || customer.name || null
  const { data: inserted, error: insertError } = await supabase
    .from('finance_orders')
    .insert({
      pi_id: pi.id,
      pi_number_snapshot: pi.pi_number,
      customer_name_snapshot: customerName,
      salesperson_id: pi.created_by,
      salesperson_name_snapshot: salesperson?.full_name || salesperson?.email || null,
      order_date: parsed.data.order_date,
      amount_original: pi.total,
      currency: pi.currency,
      exchange_rate_to_cny: normalizedRate(pi.currency, parsed.data.exchange_rate_to_cny),
      notes: parsed.data.notes || null,
      created_by: profile.id,
    })
    .select('id')
    .single()

  if (insertError) {
    if (insertError.code === '23505') return { ok: false, error: '该 PI 已登记过业绩' }
    return { ok: false, error: insertError.message }
  }

  revalidateFinance()
  return { ok: true, id: inserted.id }
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
    finance_order_id: formData.get('finance_order_id'),
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

  const supabase = await createClient()
  const { error } = await supabase.from('finance_order_costs').insert({
    finance_order_id: parsed.data.finance_order_id,
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
