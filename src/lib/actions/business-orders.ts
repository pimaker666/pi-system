'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin, requireApproved, requireFinanceAccess } from '@/lib/auth'
import {
  businessOrderFinanceSchema,
  businessOrderInputSchema,
  businessOrderPaymentInputSchema,
  businessOrderReasonSchema,
} from '@/schemas/business-order'
import type { BusinessOrderStatus } from '@/types'
import type { ActionResult } from './products'

export interface BusinessOrderActionResult extends ActionResult {
  id?: string
  order_number?: string
  version?: number
}

interface BusinessOrderRpcRow {
  id: string
  order_number: string
  version: number
}

function revalidateBusinessOrders(id?: string) {
  revalidatePath('/business-orders')
  revalidatePath('/finance/performance')
  revalidatePath('/finance')
  if (id) {
    revalidatePath(`/business-orders/${id}`)
    revalidatePath(`/finance/performance/${id}`)
  }
}

function firstValidationError(error: { issues: Array<{ message: string }> }) {
  return error.issues[0]?.message ?? '数据校验失败'
}

function businessOrderError(message: string, fallback = '业务订单操作失败') {
  const mappings: Array<[string, string]> = [
    ['Only approved sales users', '仅已审核通过的业务员可以创建订单'],
    ['Approved account required', '账号尚未审核通过'],
    ['Customer does not exist', '客户不存在或不属于该业务员'],
    ['Product does not exist or is inactive', '订单中包含不存在或已停用的产品'],
    ['Business order does not exist', '业务订单不存在'],
    ['Business order version conflict', '订单已被其他人修改，请刷新后重试'],
    ['Salesperson cannot edit', '当前状态下业务员不能编辑此订单'],
    ['Salesperson cannot add payment', '当前状态下不能新增收款'],
    ['Salesperson cannot update payment', '当前状态下不能修改收款'],
    ['Salesperson cannot void payment', '当前状态下不能作废收款'],
    ['Role cannot update business order payments', '当前角色不能修改收款'],
    ['Correction reason is required', '修正已完成订单时必须填写原因'],
    ['Invalid payment proof path', '收款凭证路径不合法'],
    ['Payment proof object does not exist', '收款凭证尚未成功上传，请重新上传'],
    ['Payment amount must be between', '收款金额必须大于 0 且不能超过上限'],
    ['Payment does not exist', '收款记录不存在'],
    ['Payment is already voided', '该收款已作废'],
    ['Completed order must keep', '已完成订单必须保留至少一笔有效收款'],
    ['At least one order item', '订单至少需要一条产品明细'],
    ['Order items cannot exceed', '订单明细不能超过 500 条'],
    ['At least one active payment', '提交前至少需要一条未作废收款'],
    ['Every active payment must have an uploaded proof', '每条未作废收款都必须有已上传凭证'],
    ['Rejection note is required', '驳回时必须填写原因'],
    ['Wage amount and calculation notes', '完成前必须填写工资/提成与计算说明'],
    ['Invalid business order transition', '当前角色或订单状态不允许此操作'],
    ['Only finance can edit approved', '仅财务可以填写已审批订单的核算信息'],
    ['Finance fields cannot be edited', '当前订单状态不能修改财务信息'],
    ['duplicate key value', '数据已存在，请检查收款凭证是否重复'],
  ]
  return mappings.find(([source]) => message.includes(source))?.[1] ?? fallback
}

function parseRpcOrder(data: unknown): BusinessOrderRpcRow | null {
  const candidate = Array.isArray(data) ? data[0] : data
  if (!candidate || typeof candidate !== 'object') return null
  const row = candidate as Record<string, unknown>
  if (
    typeof row.id !== 'string' ||
    typeof row.order_number !== 'string' ||
    typeof row.version !== 'number'
  ) {
    return null
  }
  return { id: row.id, order_number: row.order_number, version: row.version }
}

function parseRpcPaymentOrderId(data: unknown) {
  const candidate = Array.isArray(data) ? data[0] : data
  if (!candidate || typeof candidate !== 'object') return null
  const orderId = (candidate as Record<string, unknown>).order_id
  return typeof orderId === 'string' ? orderId : null
}

export async function createBusinessOrder(rawInput: unknown): Promise<BusinessOrderActionResult> {
  const profile = await requireApproved()
  if (profile.role !== 'sales') {
    return { ok: false, error: '仅业务员可以创建业务订单' }
  }

  const parsed = businessOrderInputSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  const input = parsed.data
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('create_business_order', {
    p_customer_id: input.customer_id,
    p_order_date: input.order_date,
    p_fulfillment_type: input.fulfillment_type,
    p_currency: input.currency,
    p_exchange_rate_to_cny: input.exchange_rate_to_cny,
    p_shipping_fee: input.shipping_fee,
    p_tracking_number: input.tracking_number || null,
    p_sales_notes: input.sales_notes || null,
    p_items: input.items,
  })

  if (error) return { ok: false, error: businessOrderError(error.message, '创建业务订单失败') }
  const order = parseRpcOrder(data)
  if (!order) return { ok: false, error: '数据库未返回新订单信息' }

  revalidateBusinessOrders(order.id)
  return { ok: true, ...order }
}

export async function updateBusinessOrder(
  id: string,
  expectedVersion: number,
  rawInput: unknown,
  reason = '',
): Promise<BusinessOrderActionResult> {
  const profile = await requireApproved()
  if (!['sales', 'admin', 'finance'].includes(profile.role)) {
    return { ok: false, error: '当前角色不能编辑业务订单' }
  }
  if ((profile.role === 'admin' || profile.role === 'finance') && !reason.trim()) {
    return { ok: false, error: '修正已完成订单时必须填写原因' }
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { ok: false, error: '订单版本无效，请刷新后重试' }
  }

  const parsed = businessOrderInputSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }
  const parsedReason = businessOrderReasonSchema.safeParse(reason)
  if (!parsedReason.success) return { ok: false, error: firstValidationError(parsedReason.error) }

  const input = parsed.data
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('update_business_order', {
    p_order_id: id,
    p_expected_version: expectedVersion,
    p_customer_id: input.customer_id,
    p_order_date: input.order_date,
    p_fulfillment_type: input.fulfillment_type,
    p_currency: input.currency,
    p_exchange_rate_to_cny: input.exchange_rate_to_cny,
    p_shipping_fee: input.shipping_fee,
    p_tracking_number: input.tracking_number || null,
    p_sales_notes: input.sales_notes || null,
    p_items: input.items,
    p_reason: parsedReason.data || null,
  })

  if (error) return { ok: false, error: businessOrderError(error.message, '更新业务订单失败') }
  const order = parseRpcOrder(data)
  if (!order) return { ok: false, error: '数据库未返回订单信息' }

  revalidateBusinessOrders(id)
  return { ok: true, ...order }
}

export async function addBusinessOrderPayment(
  orderId: string,
  rawInput: unknown,
): Promise<ActionResult> {
  const profile = await requireApproved()
  if ((profile.role === 'admin' || profile.role === 'finance') && !(rawInput as { reason?: unknown })?.reason) {
    return { ok: false, error: '修正已完成订单时必须填写原因' }
  }

  const parsed = businessOrderPaymentInputSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  const input = parsed.data
  const supabase = await createClient()
  const { error } = await supabase.rpc('add_business_order_payment', {
    p_order_id: orderId,
    p_payment_type: input.payment_type,
    p_amount: input.amount,
    p_received_at: new Date(input.received_at).toISOString(),
    p_proof_path: input.proof_path,
    p_notes: input.notes || null,
    p_reason: input.reason || null,
  })

  if (error) return { ok: false, error: businessOrderError(error.message, '新增收款失败') }
  revalidateBusinessOrders(orderId)
  return { ok: true }
}

export async function updateBusinessOrderPayment(
  paymentId: string,
  rawInput: unknown,
): Promise<ActionResult> {
  const profile = await requireApproved()
  if ((profile.role === 'admin' || profile.role === 'finance') && !(rawInput as { reason?: unknown })?.reason) {
    return { ok: false, error: '修正已完成订单时必须填写原因' }
  }

  const parsed = businessOrderPaymentInputSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  const input = parsed.data
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('update_business_order_payment', {
    p_payment_id: paymentId,
    p_payment_type: input.payment_type,
    p_amount: input.amount,
    p_received_at: new Date(input.received_at).toISOString(),
    p_proof_path: input.proof_path,
    p_notes: input.notes || null,
    p_reason: input.reason || null,
  })

  if (error) return { ok: false, error: businessOrderError(error.message, '修改收款失败') }
  revalidateBusinessOrders(parseRpcPaymentOrderId(data) ?? undefined)
  return { ok: true }
}

export async function voidBusinessOrderPayment(
  paymentId: string,
  reason = '',
): Promise<ActionResult> {
  const profile = await requireApproved()
  if ((profile.role === 'admin' || profile.role === 'finance') && !reason.trim()) {
    return { ok: false, error: '修正已完成订单时必须填写原因' }
  }
  const parsedReason = businessOrderReasonSchema.safeParse(reason)
  if (!parsedReason.success) return { ok: false, error: firstValidationError(parsedReason.error) }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('void_business_order_payment', {
    p_payment_id: paymentId,
    p_reason: parsedReason.data || null,
  })

  if (error) return { ok: false, error: businessOrderError(error.message, '作废收款失败') }
  revalidateBusinessOrders(parseRpcPaymentOrderId(data) ?? undefined)
  return { ok: true }
}

export async function getBusinessOrderPaymentProofUrl(
  paymentId: string,
): Promise<{ url?: string; error?: string }> {
  await requireApproved()
  const supabase = await createClient()
  const { data: payment, error } = await supabase
    .from('business_order_payments')
    .select('proof_path')
    .eq('id', paymentId)
    .single()

  if (error || !payment?.proof_path) {
    return { error: error?.message || '收款凭证不存在或无权查看' }
  }

  const admin = createAdminClient()
  const { data: signed, error: signError } = await admin.storage
    .from('business-payment-proofs')
    .createSignedUrl(payment.proof_path, 60 * 10)
  if (signError) return { error: signError.message }

  return { url: signed.signedUrl }
}

async function transitionBusinessOrder(
  id: string,
  target: BusinessOrderStatus,
  note: string,
): Promise<ActionResult> {
  const parsedNote = businessOrderReasonSchema.safeParse(note)
  if (!parsedNote.success) return { ok: false, error: firstValidationError(parsedNote.error) }

  const supabase = await createClient()
  const { error } = await supabase.rpc('transition_business_order', {
    p_order_id: id,
    p_target: target,
    p_note: parsedNote.data || null,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '订单状态更新失败') }

  revalidateBusinessOrders(id)
  return { ok: true }
}

export async function submitBusinessOrder(id: string, note = ''): Promise<ActionResult> {
  const profile = await requireApproved()
  if (profile.role !== 'sales') return { ok: false, error: '仅业务员可以提交订单' }
  return transitionBusinessOrder(id, 'submitted', note)
}

export async function approveBusinessOrder(id: string, note = ''): Promise<ActionResult> {
  await requireAdmin()
  return transitionBusinessOrder(id, 'approved', note)
}

export async function rejectBusinessOrder(id: string, note: string): Promise<ActionResult> {
  await requireAdmin()
  if (!note.trim()) return { ok: false, error: '驳回时必须填写原因' }
  return transitionBusinessOrder(id, 'rejected', note)
}

export async function saveBusinessOrderFinance(
  id: string,
  rawInput: unknown,
): Promise<ActionResult> {
  const profile = await requireFinanceAccess()
  const parsed = businessOrderFinanceSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }
  if (profile.role === 'admin' && !parsed.data.reason.trim()) {
    return { ok: false, error: '管理员修正已完成订单时必须填写原因' }
  }

  const supabase = await createClient()
  const { error } = await supabase.rpc('save_business_order_finance', {
    p_order_id: id,
    p_wage_amount_cny: parsed.data.wage_amount_cny,
    p_calculation_notes: parsed.data.calculation_notes,
    p_reason: parsed.data.reason || null,
  })

  if (error) return { ok: false, error: businessOrderError(error.message, '保存财务核算失败') }
  revalidateBusinessOrders(id)
  return { ok: true }
}

export async function completeBusinessOrder(id: string, note = ''): Promise<ActionResult> {
  const profile = await requireFinanceAccess()
  if (profile.role !== 'finance') return { ok: false, error: '仅财务可以完成订单' }
  return transitionBusinessOrder(id, 'completed', note)
}
