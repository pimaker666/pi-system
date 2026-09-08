'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin, requireApproved, requireFinanceAccess } from '@/lib/auth'
import {
  businessCustomerTransferAllocationInputSchema,
  businessCustomerTransferInputSchema,
  businessCustomProductInputSchema,
  businessCustomProductStateInputSchema,
  businessCustomProductVersionInputSchema,
  businessOrderFinanceSchema,
  businessOrderInputSchema,
  businessOrderPaymentInputSchema,
  businessOrderReasonSchema,
  businessOrderShipmentInputSchema,
  businessOrderVoidReasonSchema,
} from '@/schemas/business-order'
import type {
  BusinessCustomerPrepayment,
  BusinessCustomerTransfer,
  BusinessCustomProduct,
  BusinessCustomProductListItem,
  BusinessCustomProductVersion,
  BusinessOrderPaymentAllocation,
  BusinessOrderSettlementSummary,
  BusinessOrderShipment,
  BusinessOrderShipmentItem,
  BusinessOrderStatus,
} from '@/types'
import type { ActionResult } from './products'

export interface BusinessOrderActionResult extends ActionResult {
  id?: string
  order_number?: string
  version?: number
}

export interface BusinessCustomProductActionResult extends ActionResult {
  product?: BusinessCustomProduct
  version?: BusinessCustomProductVersion | null
}

export interface BusinessCustomerTransferActionResult extends ActionResult {
  transfer?: BusinessCustomerTransfer
  allocations?: BusinessOrderPaymentAllocation[]
}

export interface BusinessOrderShipmentActionResult extends ActionResult {
  shipment?: BusinessOrderShipment
  items?: BusinessOrderShipmentItem[]
}

export interface BusinessCustomProductListResult extends ActionResult {
  data?: BusinessCustomProductListItem[]
}

export interface BusinessCustomerPrepaymentResult extends ActionResult {
  data?: BusinessCustomerPrepayment[]
}

export interface BusinessOrderSettlementSummaryResult extends ActionResult {
  data?: BusinessOrderSettlementSummary
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

function revalidateBusinessOrderIds(ids: string[]) {
  revalidateBusinessOrders()
  for (const id of new Set(ids)) {
    revalidatePath(`/business-orders/${id}`)
    revalidatePath(`/finance/performance/${id}`)
  }
}

function firstValidationError(error: { issues: Array<{ message: string }> }) {
  return error.issues[0]?.message ?? '数据校验失败'
}

function businessOrderError(message: string, fallback = '业务订单操作失败') {
  const mappings: Array<[string, string]> = [
    ['Only approved sales users', '仅已审核通过的业务员或业务主管可以执行此操作'],
    ['Only approved administrators or finance users', '仅管理员或财务可以执行此操作'],
    ['Approved business role required', '当前账号无业务操作权限'],
    ['Approved account required', '账号尚未审核通过'],
    ['Customer does not exist or is not owned', '客户不存在或不属于当前业务员'],
    ['Customer does not exist', '客户不存在或不属于该业务员'],
    ['Customer context is not accessible', '无权访问该客户的定制产品'],
    ['Customer is not accessible', '无权访问该客户'],
    ['Customer is not manageable', '无权管理该客户'],
    ['Custom product customer is not manageable', '无权管理该定制产品所属客户'],
    ['Custom product customer is not owned', '定制产品客户不属于当前业务员'],
    ['Only administrators or finance users can share custom products', '仅管理员或财务可以允许其他客户复用定制产品'],
    ['Custom product does not exist', '定制产品不存在'],
    ['Custom product version does not belong', '定制产品版本与产品不匹配'],
    ['Custom product is archived', '定制产品已归档'],
    ['Archived custom product', '已归档的定制产品不能新增版本'],
    ['Custom product code is required', '定制产品编码不能为空且不能超过 100 字'],
    ['Custom product name is required', '定制产品名称不能为空且不能超过 300 字'],
    ['Custom product unit is required', '定制产品单位不能为空且不能超过 100 字'],
    ['Custom product version text exceeds', '定制产品版本文本超过长度限制'],
    ['Default unit price is invalid', '定制产品默认单价不合法'],
    ['Reason cannot exceed', '原因不能超过 1000 字'],
    ['Product does not exist or is inactive', '订单中包含不存在或已停用的产品'],
    ['Catalog item requires only product_id', '目录产品明细只能指定产品 ID'],
    ['Custom item requires only', '定制产品明细必须指定产品及版本，且不能指定目录产品'],
    ['Invalid order item source_type', '订单明细来源类型不合法'],
    ['Business order does not exist', '业务订单不存在'],
    ['Business order is not accessible', '无权查看该业务订单'],
    ['Business order version conflict', '订单已被其他人修改，请刷新后重试'],
    ['Salesperson cannot edit', '当前状态下业务员不能编辑此订单'],
    ['Cannot change customer after payment allocation', '已有分摊或订单已完成，不能更换客户'],
    ['Cannot change currency after payment allocation', '已有分摊或订单已完成，不能更换币种'],
    ['Order total cannot be less than active payment allocations', '订单总额不能低于有效收款分摊'],
    ['Completed order items cannot be changed', '已完成并发货的订单不能修改产品明细'],
    ['Completed order correction must preserve', '已完成订单的审批、收款和发货状态必须保持完成'],
    ['Customer transfer does not exist', '客户转账不存在'],
    ['Customer transfer is voided', '客户转账已作废'],
    ['Active customer transfer does not exist', '有效客户转账不存在'],
    ['Transfer idempotency result is missing', '转账幂等记录异常，请联系管理员'],
    ['Idempotency key was already used', '该幂等键已用于不同内容，请勿重复提交'],
    ['Invalid transfer proof path', '收款凭证路径不合法'],
    ['Transfer proof object does not exist', '收款凭证尚未成功上传，请重新上传'],
    ['Transfer amount is invalid', '转账金额必须大于 0 且不能超过上限'],
    ['Exchange rate is invalid', '汇率必须大于 0 且不能超过上限'],
    ['CNY exchange rate must equal one', '人民币汇率必须为 1'],
    ['Received time is required', '请选择收款时间'],
    ['Idempotency key is required', '缺少有效幂等键'],
    ['Transfer notes cannot exceed', '转账备注不能超过 1000 字'],
    ['Allocations must be a JSON array', '分摊数据格式不正确'],
    ['Allocations cannot exceed', '分摊不能超过 500 条'],
    ['Each allocation must have a unique order_id', '同一订单不能重复分摊'],
    ['One or more allocation orders do not exist', '一个或多个分摊订单不存在'],
    ['Allocations exceed transfer available amount', '分摊金额超过转账可用余额'],
    ['Correction reason is required for legacy completed order allocations', '分摊到历史已完成订单时必须填写修正原因'],
    ['Allocation amount is invalid', '分摊金额不合法'],
    ['Allocation payment type is invalid', '分摊收款类型不合法'],
    ['Allocation exceeds order outstanding amount', '分摊金额超过订单未收金额'],
    ['Allocation order customer does not match', '分摊订单与转账客户不一致'],
    ['Allocation order currency does not match', '分摊订单与转账币种不一致'],
    ['Sales user cannot allocate', '业务员不能向其他业务员的订单分摊'],
    ['Role cannot allocate', '当前角色不能追加转账分摊'],
    ['Active allocation does not exist', '有效收款分摊不存在'],
    ['Sales user cannot void another salesperson allocation', '业务员不能作废其他业务员的分摊'],
    ['Role cannot void payment allocations', '当前角色不能作废收款分摊'],
    [
      'Completed order allocations require the legacy admin/finance correction path',
      '已完成订单仅允许管理员或财务修正历史订单收款；新版完成订单不可修改',
    ],
    [
      'Completed order transfers require the legacy admin/finance correction path',
      '该转账关联已完成订单，仅允许管理员或财务修正历史订单；关联新版完成订单时不可作废',
    ],
    ['Cannot void allocation on a gate-v2 completed order', '已完成订单的收款分摊不能作废'],
    ['Cannot void transfer allocated to a gate-v2 completed order', '该转账已分摊至完成订单，不能作废'],
    ['Only approved orders can be shipped', '仅已审批订单可以发货'],
    ['Shipped time is required', '请选择发货时间'],
    ['Shipment text exceeds', '物流单号或发货备注超过长度限制'],
    ['Shipment items count must be between', '发货明细必须为 1 至 500 条'],
    ['Each shipment order_item_id must be unique', '同一订单明细不能重复发货'],
    ['One or more shipment items do not belong', '发货明细不属于该订单'],
    ['Shipment quantity is invalid', '发货数量不合法'],
    ['Shipment quantity exceeds remaining', '发货数量超过订单明细剩余数量'],
    ['Shipment idempotency result is missing', '发货幂等记录异常，请联系管理员'],
    ['Sales user cannot ship another salesperson order', '业务员不能为其他业务员的订单发货'],
    ['Role cannot create shipments', '当前角色不能创建发货批次'],
    ['Active shipment does not exist', '有效发货批次不存在'],
    ['Only approved orders can have shipments voided', '仅已审批订单可以作废发货'],
    ['Sales user cannot void another salesperson shipment', '业务员不能作废其他业务员的发货批次'],
    ['Role cannot void shipments', '当前角色不能作废发货批次'],
    ['Void reason is required', '请填写作废原因'],
    ['At least one order item', '订单至少需要一条产品明细'],
    ['Order items count must be between', '订单明细必须为 1 至 500 条'],
    ['Rejection note is required', '驳回时必须填写原因'],
    ['Completion requires approved, fully paid, and fully shipped', '完成订单前必须审批、全额收款并全部发货'],
    ['Wage amount and calculation notes', '完成前必须填写工资/提成与计算说明'],
    ['Invalid business order transition', '当前角色或订单状态不允许此操作'],
    ['Only finance can edit approved', '仅财务可以填写已审批订单的核算信息'],
    ['Finance fields cannot be edited', '当前订单状态不能修改财务信息'],
    ['duplicate key value', '数据已存在，请检查凭证或幂等键是否重复'],
  ]
  return mappings.find(([source]) => message.includes(source))?.[1] ?? fallback
}

function firstRpcRow<T extends object>(data: unknown): T | null {
  const candidate = Array.isArray(data) ? data[0] : data
  if (!candidate || typeof candidate !== 'object') return null
  return candidate as T
}

function parseRpcOrder(data: unknown): BusinessOrderRpcRow | null {
  const row = firstRpcRow<Record<string, unknown>>(data)
  if (
    !row ||
    typeof row.id !== 'string' ||
    typeof row.order_number !== 'string' ||
    typeof row.version !== 'number'
  ) {
    return null
  }
  return { id: row.id, order_number: row.order_number, version: row.version }
}

function nullableText(value: string) {
  return value || null
}

function customVersionPayload(
  input: ReturnType<typeof businessCustomProductVersionInputSchema.parse>,
) {
  return {
    code: input.code,
    name: input.name,
    description: nullableText(input.description),
    specification: nullableText(input.specification),
    unit: input.unit,
    image_url: nullableText(input.image_url),
    default_unit_price: input.default_unit_price,
    default_currency: input.default_currency,
  }
}

function allocationPayload(
  allocations: Array<{ order_id: string; amount: number; payment_type?: string }>,
) {
  return allocations.map((allocation) => ({
    order_id: allocation.order_id,
    amount: allocation.amount,
    payment_type: allocation.payment_type ?? null,
  }))
}

export async function createBusinessOrder(rawInput: unknown): Promise<BusinessOrderActionResult> {
  const profile = await requireApproved()
  if (!['sales', 'supervisor'].includes(profile.role)) {
    return { ok: false, error: '仅业务员或业务主管可以创建业务订单' }
  }

  const parsed = businessOrderInputSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  const input = parsed.data
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('create_business_order_v2', {
    p_customer_id: input.customer_id,
    p_order_date: input.order_date,
    p_fulfillment_type: input.fulfillment_type,
    p_currency: input.currency,
    p_exchange_rate_to_cny: input.exchange_rate_to_cny,
    p_shipping_fee: input.shipping_fee,
    p_tracking_number: nullableText(input.tracking_number),
    p_sales_notes: nullableText(input.sales_notes),
    p_items: input.items,
    p_payment_due_date: nullableText(input.payment_due_date),
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
  if (!['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)) {
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
  const { data, error } = await supabase.rpc('update_business_order_v2', {
    p_order_id: id,
    p_expected_version: expectedVersion,
    p_customer_id: input.customer_id,
    p_order_date: input.order_date,
    p_fulfillment_type: input.fulfillment_type,
    p_currency: input.currency,
    p_exchange_rate_to_cny: input.exchange_rate_to_cny,
    p_shipping_fee: input.shipping_fee,
    p_tracking_number: nullableText(input.tracking_number),
    p_sales_notes: nullableText(input.sales_notes),
    p_items: input.items,
    p_payment_due_date: nullableText(input.payment_due_date),
    p_reason: nullableText(parsedReason.data),
  })

  if (error) return { ok: false, error: businessOrderError(error.message, '更新业务订单失败') }
  const order = parseRpcOrder(data)
  if (!order) return { ok: false, error: '数据库未返回订单信息' }

  revalidateBusinessOrders(id)
  return { ok: true, ...order }
}

export async function createBusinessCustomProduct(
  rawInput: unknown,
): Promise<BusinessCustomProductActionResult> {
  const profile = await requireApproved()
  if (!['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)) {
    return { ok: false, error: '当前角色不能创建定制产品' }
  }

  const parsed = businessCustomProductInputSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('create_business_custom_product', {
    p_customer_id: parsed.data.customer_id,
    p_initial_version: parsed.data.initial_version
      ? customVersionPayload(parsed.data.initial_version)
      : null,
    p_is_shared: parsed.data.is_shared,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '创建定制产品失败') }

  const result = firstRpcRow<{
    product: BusinessCustomProduct
    version: BusinessCustomProductVersion | null
  }>(data)
  if (!result?.product) return { ok: false, error: '数据库未返回定制产品信息' }

  revalidateBusinessOrders()
  return { ok: true, product: result.product, version: result.version ?? null }
}

export async function addBusinessCustomProductVersion(
  customProductId: string,
  rawInput: unknown,
): Promise<BusinessCustomProductActionResult> {
  const profile = await requireApproved()
  if (!['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)) {
    return { ok: false, error: '当前角色不能新增定制产品版本' }
  }

  const parsed = businessCustomProductVersionInputSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }
  const input = parsed.data

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('add_business_custom_product_version', {
    p_custom_product_id: customProductId,
    p_code: input.code,
    p_name: input.name,
    p_description: nullableText(input.description),
    p_specification: nullableText(input.specification),
    p_unit: input.unit,
    p_image_url: nullableText(input.image_url),
    p_default_unit_price: input.default_unit_price,
    p_default_currency: input.default_currency,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '新增定制产品版本失败') }

  const version = firstRpcRow<BusinessCustomProductVersion>(data)
  if (!version) return { ok: false, error: '数据库未返回定制产品版本信息' }

  revalidateBusinessOrders()
  return { ok: true, version }
}

export async function setBusinessCustomProductState(
  customProductId: string,
  rawInput: unknown,
): Promise<BusinessCustomProductActionResult> {
  await requireFinanceAccess()
  const parsed = businessCustomProductStateInputSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('set_business_custom_product_state', {
    p_custom_product_id: customProductId,
    p_is_shared: parsed.data.is_shared,
    p_is_archived: parsed.data.is_archived,
    p_reason: nullableText(parsed.data.reason),
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '更新定制产品状态失败') }

  const product = firstRpcRow<BusinessCustomProduct>(data)
  if (!product) return { ok: false, error: '数据库未返回定制产品信息' }

  revalidateBusinessOrders()
  return { ok: true, product }
}

export async function listBusinessCustomProductsForCustomer(
  customerId: string,
): Promise<BusinessCustomProductListResult> {
  await requireApproved()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('list_business_custom_products_for_customer', {
    p_customer_id: customerId,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '读取定制产品失败') }

  return { ok: true, data: (data ?? []) as BusinessCustomProductListItem[] }
}

export async function recordBusinessCustomerTransfer(
  rawInput: unknown,
): Promise<BusinessCustomerTransferActionResult> {
  const profile = await requireApproved()
  if (!['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)) {
    return { ok: false, error: '当前角色不能登记客户转账' }
  }

  const parsed = businessCustomerTransferInputSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }
  const input = parsed.data

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('record_business_customer_transfer', {
    p_customer_id: input.customer_id,
    p_currency: input.currency,
    p_amount: input.amount,
    p_exchange_rate_to_cny: input.exchange_rate_to_cny,
    p_received_at: new Date(input.received_at).toISOString(),
    p_payment_type: input.payment_type,
    p_proof_path: input.proof_path,
    p_notes: nullableText(input.notes),
    p_correction_reason: nullableText(input.correction_reason),
    p_idempotency_key: input.idempotency_key,
    p_allocations: allocationPayload(input.allocations),
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '登记客户转账失败') }

  const result = firstRpcRow<{
    transfer: BusinessCustomerTransfer
    allocations: BusinessOrderPaymentAllocation[]
  }>(data)
  if (!result?.transfer) return { ok: false, error: '数据库未返回客户转账信息' }

  revalidateBusinessOrderIds(input.allocations.map((allocation) => allocation.order_id))
  return { ok: true, transfer: result.transfer, allocations: result.allocations ?? [] }
}

export async function allocateBusinessCustomerTransfer(
  transferId: string,
  rawInput: unknown,
): Promise<BusinessCustomerTransferActionResult> {
  const profile = await requireApproved()
  if (!['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)) {
    return { ok: false, error: '当前角色不能追加转账分摊' }
  }

  const parsed = businessCustomerTransferAllocationInputSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('allocate_business_customer_transfer', {
    p_transfer_id: transferId,
    p_allocations: allocationPayload(parsed.data.allocations),
    p_correction_reason: nullableText(parsed.data.correction_reason),
    p_idempotency_key: parsed.data.idempotency_key,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '追加转账分摊失败') }

  const result = firstRpcRow<{
    transfer_id: string
    allocations: BusinessOrderPaymentAllocation[]
  }>(data)
  if (!result) return { ok: false, error: '数据库未返回转账分摊信息' }

  revalidateBusinessOrderIds(parsed.data.allocations.map((allocation) => allocation.order_id))
  return { ok: true, allocations: result.allocations ?? [] }
}

export async function voidBusinessOrderPaymentAllocation(
  allocationId: string,
  reason: string,
): Promise<ActionResult> {
  const profile = await requireApproved()
  if (!['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)) {
    return { ok: false, error: '当前角色不能作废收款分摊' }
  }
  const parsedReason = businessOrderVoidReasonSchema.safeParse(reason)
  if (!parsedReason.success) return { ok: false, error: firstValidationError(parsedReason.error) }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('void_business_order_payment_allocation', {
    p_allocation_id: allocationId,
    p_reason: parsedReason.data,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '作废收款分摊失败') }

  const allocation = firstRpcRow<BusinessOrderPaymentAllocation>(data)
  revalidateBusinessOrders(allocation?.order_id)
  return { ok: true }
}

export async function voidBusinessCustomerTransfer(
  transferId: string,
  reason: string,
): Promise<ActionResult> {
  const profile = await requireApproved()
  if (!['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)) {
    return { ok: false, error: '当前角色不能作废客户转账' }
  }
  const parsedReason = businessOrderVoidReasonSchema.safeParse(reason)
  if (!parsedReason.success) return { ok: false, error: firstValidationError(parsedReason.error) }

  const supabase = await createClient()
  const { data: relatedAllocations } = await supabase
    .from('business_order_payment_allocations')
    .select('order_id')
    .eq('transfer_id', transferId)
    .is('voided_at', null)

  const { error } = await supabase.rpc('void_business_customer_transfer', {
    p_transfer_id: transferId,
    p_reason: parsedReason.data,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '作废客户转账失败') }

  revalidateBusinessOrderIds((relatedAllocations ?? []).map((item) => item.order_id as string))
  return { ok: true }
}

export async function createBusinessOrderShipment(
  orderId: string,
  rawInput: unknown,
): Promise<BusinessOrderShipmentActionResult> {
  const profile = await requireApproved()
  if (!['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)) {
    return { ok: false, error: '当前角色不能创建发货批次' }
  }

  const parsed = businessOrderShipmentInputSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('create_business_order_shipment', {
    p_order_id: orderId,
    p_shipped_at: new Date(parsed.data.shipped_at).toISOString(),
    p_tracking_number: nullableText(parsed.data.tracking_number),
    p_notes: nullableText(parsed.data.notes),
    p_items: parsed.data.items,
    p_idempotency_key: parsed.data.idempotency_key,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '创建发货批次失败') }

  const result = firstRpcRow<{
    shipment: BusinessOrderShipment
    items: BusinessOrderShipmentItem[]
  }>(data)
  if (!result?.shipment) return { ok: false, error: '数据库未返回发货批次信息' }

  revalidateBusinessOrders(orderId)
  return { ok: true, shipment: result.shipment, items: result.items ?? [] }
}

export async function voidBusinessOrderShipment(
  shipmentId: string,
  reason: string,
): Promise<ActionResult> {
  const profile = await requireApproved()
  if (!['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)) {
    return { ok: false, error: '当前角色不能作废发货批次' }
  }
  const parsedReason = businessOrderVoidReasonSchema.safeParse(reason)
  if (!parsedReason.success) return { ok: false, error: firstValidationError(parsedReason.error) }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('void_business_order_shipment', {
    p_shipment_id: shipmentId,
    p_reason: parsedReason.data,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '作废发货批次失败') }

  const shipment = firstRpcRow<BusinessOrderShipment>(data)
  revalidateBusinessOrders(shipment?.order_id)
  return { ok: true }
}

export async function getBusinessCustomerPrepayment(
  customerId: string,
): Promise<BusinessCustomerPrepaymentResult> {
  await requireApproved()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('get_business_customer_prepayment', {
    p_customer_id: customerId,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '读取客户预收余额失败') }

  return { ok: true, data: (data ?? []) as BusinessCustomerPrepayment[] }
}

export async function getBusinessOrderSettlementSummary(
  orderId: string,
): Promise<BusinessOrderSettlementSummaryResult> {
  await requireApproved()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('get_business_order_settlement_summary', {
    p_order_id: orderId,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '读取订单结算汇总失败') }

  const summary = firstRpcRow<BusinessOrderSettlementSummary>(data)
  if (!summary) return { ok: false, error: '订单结算汇总不存在' }
  return { ok: true, data: summary }
}

/**
 * Legacy export for existing callers. A payment is now recorded as one customer transfer
 * allocated to the supplied order, so customer/currency/rate/idempotency are mandatory.
 */
export async function addBusinessOrderPayment(
  orderId: string,
  rawInput: unknown,
): Promise<ActionResult> {
  const profile = await requireApproved()
  if (!['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)) {
    return { ok: false, error: '当前角色不能登记客户转账' }
  }

  const parsed = businessOrderPaymentInputSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }
  const input = parsed.data

  const allocations = allocationPayload([
    { order_id: orderId, amount: input.amount, payment_type: input.payment_type },
  ])
  const supabase = await createClient()
  const { error } = await supabase.rpc('record_business_customer_transfer', {
    p_customer_id: input.customer_id,
    p_currency: input.currency,
    p_amount: input.amount,
    p_exchange_rate_to_cny: input.exchange_rate_to_cny,
    p_received_at: new Date(input.received_at).toISOString(),
    p_payment_type: input.payment_type,
    p_proof_path: input.proof_path,
    p_notes: nullableText(input.notes),
    p_idempotency_key: input.idempotency_key,
    p_allocations: allocations,
  })

  if (error) return { ok: false, error: businessOrderError(error.message, '新增收款失败') }
  revalidateBusinessOrders(orderId)
  return { ok: true }
}

/** Legacy export: payment IDs are now allocation IDs. */
export async function voidBusinessOrderPayment(
  allocationId: string,
  reason = '',
): Promise<ActionResult> {
  return voidBusinessOrderPaymentAllocation(allocationId, reason)
}

/** Legacy payment rows are immutable after migration 0028. */
export async function updateBusinessOrderPayment(
  paymentId: string,
  rawInput: unknown,
): Promise<ActionResult> {
  await requireApproved()
  void paymentId
  void rawInput
  return { ok: false, error: '不再支持原地修改收款，请作废分摊后重新登记' }
}

export async function getBusinessOrderPaymentProofUrl(
  allocationId: string,
): Promise<{ url?: string; error?: string }> {
  await requireApproved()
  const supabase = await createClient()
  const { data: allocation, error: allocationError } = await supabase
    .from('business_order_payment_allocations')
    .select('transfer_id')
    .eq('id', allocationId)
    .single()

  if (allocationError || !allocation?.transfer_id) {
    return { error: '收款分摊不存在或无权查看' }
  }

  const { data: transfer, error: transferError } = await supabase
    .from('business_customer_transfers')
    .select('proof_path')
    .eq('id', allocation.transfer_id)
    .single()

  if (transferError || !transfer?.proof_path) {
    return { error: '收款凭证不存在或无权查看' }
  }

  const admin = createAdminClient()
  const { data: signed, error: signError } = await admin.storage
    .from('business-payment-proofs')
    .createSignedUrl(transfer.proof_path, 60 * 10)
  if (signError) return { error: '生成收款凭证链接失败' }

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
    p_note: nullableText(parsedNote.data),
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '订单状态更新失败') }

  revalidateBusinessOrders(id)
  return { ok: true }
}

export async function submitBusinessOrder(id: string, note = ''): Promise<ActionResult> {
  const profile = await requireApproved()
  if (!['sales', 'supervisor'].includes(profile.role)) {
    return { ok: false, error: '仅业务员或业务主管可以提交订单' }
  }
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
    p_reason: nullableText(parsed.data.reason),
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
