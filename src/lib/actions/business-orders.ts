'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin, requireApproved, requireFinanceAccess } from '@/lib/auth'
import {
  businessCustomerTransferAllocationInputSchema,
  businessCustomerTransferInputSchema,
  businessCustomProductInputSchema,
  businessCustomProductLibraryFilterSchema,
  businessCustomProductStateInputSchema,
  businessCustomProductVersionInputSchema,
  businessOrderAttachmentInputSchema,
  businessOrderFinanceSchema,
  businessOrderInputSchema,
  businessOrderReasonSchema,
  businessOrderReturnInputSchema,
  businessOrderReturnVoidInputSchema,
  businessOrderShipmentInputSchema,
  businessOrderSpecialCloseInputSchema,
  businessOrderVoidReasonSchema,
} from '@/schemas/business-order'
import type {
  BusinessCustomerPrepayment,
  BusinessCustomerTransfer,
  BusinessCustomProduct,
  BusinessCustomProductLibraryItem,
  BusinessCustomProductListItem,
  BusinessCustomProductVersion,
  BusinessOrderAttachment,
  BusinessOrderEditConstraints,
  BusinessOrderPaymentAllocation,
  BusinessOrderReturn,
  BusinessOrderReturnItem,
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

export interface BusinessOrderAttachmentActionResult extends ActionResult {
  attachment?: BusinessOrderAttachment
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

export interface BusinessOrderReturnActionResult extends ActionResult {
  return?: BusinessOrderReturn
  items?: BusinessOrderReturnItem[]
}

export interface BusinessOrderEditConstraintsResult extends ActionResult {
  data?: BusinessOrderEditConstraints
}

export interface BusinessCustomProductListResult extends ActionResult {
  data?: BusinessCustomProductListItem[]
}

export interface BusinessCustomProductLibraryResult extends ActionResult {
  data?: BusinessCustomProductLibraryItem[]
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
  revalidatePath('/finance/daily-orders')
  revalidatePath('/finance/performance')
  revalidatePath('/finance')
  if (id) {
    revalidatePath(`/finance/daily-orders/${id}`)
  }
}

function revalidateBusinessOrderIds(ids: string[]) {
  revalidateBusinessOrders()
  for (const id of new Set(ids)) {
    revalidatePath(`/finance/daily-orders/${id}`)
  }
}

function firstValidationError(error: { issues: Array<{ message: string }> }) {
  return error.issues[0]?.message ?? '数据校验失败'
}

function businessOrderError(message: string, fallback = '业务订单操作失败') {
  const mappings: Array<[string, string]> = [
    ['Only approved sales, supervisor, or admin users', '仅已审核的业务员、主管或管理员可以创建订单'],
    ['Approved sales, supervisor, or admin account required', '仅已审核的业务员、主管或管理员可以编辑订单'],
    ['Only approved sales users', '仅已审核通过的业务员或业务主管可以执行此操作'],
    ['Only approved administrators or finance users can register returns', '仅管理员或财务可以登记退货'],
    ['Only approved administrators or finance users can void returns', '仅管理员或财务可以作废退货'],
    ['Only approved administrators or finance users', '仅管理员或财务可以执行此操作'],
    ['Only an approved administrator', '仅已审核通过的管理员可以执行此操作'],
    ['Approved business role required', '当前账号无业务操作权限'],
    ['Approved account required', '账号尚未审核通过'],
    ['Customer does not exist or is not manageable by current user', '客户不存在或当前账号无权管理'],
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
    ['Invalid daily shipping category', '每日订单发货分类不合法'],
    ['Daily order item fields are incomplete', '每日订单明细字段不完整'],
    ['Daily order item amounts are invalid', '每日订单明细金额不合法'],
    ['Daily order item amounts must be non-negative', '每日订单明细金额不能为负且最多保留两位小数'],
    ['Daily order totals are incomplete', '每日订单汇总字段不完整'],
    ['Daily order totals must be non-negative', '每日订单汇总金额不能为负且最多保留两位小数'],
    ['Total sales amount must equal', '总销售金额必须等于总产品实收加总运费实收'],
    ['Daily order shop does not exist', '所选店铺不存在'],
    ['Daily order shop is inactive', '所选店铺已停用'],
    ['Salesperson is not actively assigned to this shop', '所选业务员未有效分配到该店铺'],
    ['Assigned salesperson must be approved', '所选业务员尚未审核通过'],
    ['Administrator can assign only approved sales or admin users', '管理员只能将订单归属给已审核的业务员或管理员'],
    ['Sales or supervisor users can assign orders only to themselves', '业务员或主管只能将订单归属给自己'],
    ['External order number is required', '订单号不能为空且不能超过 200 字'],
    ['Daily shipping date is required', '请选择发货日期'],
    ['Daily payment category is required', '请选择收款类型'],
    ['Business order does not exist', '业务订单不存在'],
    ['Business order is not accessible', '无权查看该业务订单'],
    ['Business order version conflict', '订单已被其他人修改，请刷新后重试'],
    ['Business order cannot be edited in current status', '当前订单状态不可编辑'],
    ['Completed or closed business order cannot be edited', '已完成或已关闭订单不可编辑'],
    ['Business order daily fields cannot be changed after payment or shipment', '订单已有收款或发货记录，不能修改每日订单字段'],
    ['Business order item daily fields cannot be changed after payment or shipment', '订单明细已有收款或发货记录，不能修改每日订单字段'],
    ['Business order attachments cannot be changed in current status', '当前订单状态不能增删附件'],
    ['Business order attachment does not exist', '业务订单附件不存在'],
    ['Business order attachment is already removed', '业务订单附件已移除'],
    ['Business order cannot have more than 10 attachments', '每条订单最多 10 张附件'],
    ['Invalid attachment type or size', '附件必须为 JPEG/PNG，且单张不能超过 5MB'],
    ['Invalid attachment path', '附件路径不合法'],
    ['Attachment object does not exist', '附件尚未成功上传，请重新上传'],
    ['Attachment object metadata does not match', '附件类型或大小与已上传文件不一致'],
    ['Attachment path is already bound', '附件路径已绑定到其他记录'],
    ['Attachment name cannot exceed', '附件名称不能超过 255 字'],
    ['Sales user cannot edit another owner business order', '不能编辑其他业务员名下的订单'],
    ['Salesperson cannot edit', '当前状态下业务员不能编辑此订单'],
    ['Finance users cannot create business orders', '财务不能创建业务订单'],
    ['Finance users cannot edit business orders', '财务不能编辑业务订单'],
    ['Each order item id must be unique', '同一订单明细 ID 不能重复'],
    ['Order item id does not belong to order', '订单明细 ID 不属于当前订单'],
    ['Order item product identity cannot be replaced', '已有订单明细不能更换产品'],
    ['Order items cannot be deleted after an active payment allocation', '已有有效收款分摊，不能删除订单明细'],
    ['Order item product cannot be replaced after an active payment allocation', '已有有效收款分摊，不能更换订单产品'],
    ['Order item price cannot be changed after an active payment allocation', '已有有效收款分摊，不能修改订单单价'],
    ['Shipped order items cannot be deleted', '已发货订单明细不能删除'],
    ['Shipped order item product cannot be replaced', '已发货订单明细不能更换产品'],
    ['Order item quantity cannot be less than net shipped quantity', '订单数量不能低于净发货数量'],
    ['Cannot change customer after payment allocation', '已有分摊或订单已完成，不能更换客户'],
    ['Cannot change currency after payment allocation', '已有分摊或订单已完成，不能更换币种'],
    ['Order total cannot be less than active payment allocations', '订单总额不能低于有效收款分摊'],
    ['Order item is locked', '订单明细已被发货或退货记录引用，不能删除或更换产品'],
    ['Referenced order item cannot be deleted', '订单明细已被发货或退货记录引用，不能删除'],
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
    ['Idempotency key is invalid', '缺少有效幂等键或幂等键超过 200 字'],
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
    ['Shipment with active returns cannot be voided', '该发货批次已被有效退货引用，不能作废'],
    ['Shipment has active return references', '该发货批次已被有效退货引用，不能作废'],
    ['Shipment item is referenced by an active return', '该发货明细已被有效退货引用，不能作废发货'],
    ['Returned time is required', '请选择退货时间'],
    ['Return notes cannot exceed', '退货备注不能超过 1000 字'],
    ['Return items count must be between', '退货明细必须为 1 至 500 条'],
    ['Each return shipment_item_id must be unique', '同一发货明细不能重复退货'],
    ['Return shipment item does not belong to an active shipment of order', '退货来源不是该订单的有效发货明细'],
    ['Return source shipment is invalid or voided', '退货来源发货明细无效或已作废'],
    ['Return quantity is invalid', '退货数量不合法'],
    ['Return quantity exceeds source shipment item quantity', '退货数量超过该发货明细的可退数量'],
    ['Voiding return would make net shipped quantity exceed ordered quantity', '作废退货后净发货数量将超过订单数量'],
    ['Active business order return does not exist', '有效退货记录不存在'],
    ['Close reason is required', '请填写不超过 1000 字的特殊关闭原因'],
    ['Completed business order cannot be specially closed', '已完成订单不能特殊关闭'],
    ['Business order is already closed', '订单已特殊关闭，请勿重复操作'],
    ['Closed business order cannot be transitioned', '已关闭订单不能变更状态'],
    ['Completed business order is immutable', '已完成订单不可修改'],
    ['Closed business order cannot receive new shipments', '已关闭订单不能新增发货'],
    ['Invalid custom product library scope', '定制产品库查看范围不合法'],
    ['Invalid custom product library status', '定制产品库状态筛选不合法'],
    ['Only administrators or finance can list all custom products', '仅管理员或财务可以查看全部定制产品'],
    ['Customer scope requires customer_id', '按客户筛选时请选择客户'],
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

function orderItemsPayload(
  items: ReturnType<typeof businessOrderInputSchema.parse>['items'],
) {
  return items.map(({ order_item_id: orderItemId, ...item }) =>
    orderItemId ? { id: orderItemId, ...item } : item,
  )
}

export async function createBusinessOrder(rawInput: unknown): Promise<BusinessOrderActionResult> {
  const profile = await requireApproved()
  if (profile.role === 'finance') {
    return { ok: false, error: '财务不能创建业务订单' }
  }
  if (!['sales', 'supervisor', 'admin'].includes(profile.role)) {
    return { ok: false, error: '仅业务员、业务主管或管理员可以创建业务订单' }
  }

  const parsed = businessOrderInputSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  const input = parsed.data
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('create_business_order_v3', {
    p_customer_id: input.customer_id,
    p_order_date: input.order_date,
    p_fulfillment_type: input.fulfillment_type,
    p_currency: input.currency,
    p_exchange_rate_to_cny: input.exchange_rate_to_cny,
    p_shipping_fee: input.shipping_fee,
    p_tracking_number: nullableText(input.tracking_number),
    p_sales_notes: nullableText(input.sales_notes),
    p_items: orderItemsPayload(input.items),
    p_payment_due_date: nullableText(input.payment_due_date),
    p_shop_id: input.shop_id,
    p_salesperson_id: input.salesperson_id,
    p_external_order_number: input.external_order_number,
    p_daily_shipping_date: input.daily_shipping_date,
    p_daily_shipping_number: nullableText(input.daily_shipping_number),
    p_daily_payment_category: input.daily_payment_category,
    p_total_product_received_amount: input.total_product_received_amount,
    p_total_product_received_overridden: input.total_product_received_overridden,
    p_total_shipping_received_amount: input.total_shipping_received_amount,
    p_total_shipping_received_overridden: input.total_shipping_received_overridden,
    p_total_sales_amount: input.total_sales_amount,
    p_total_sales_overridden: input.total_sales_overridden,
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
  if (profile.role === 'finance') {
    return { ok: false, error: '财务不能编辑业务订单' }
  }
  if (!['sales', 'supervisor', 'admin'].includes(profile.role)) {
    return { ok: false, error: '当前角色不能编辑业务订单' }
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
  const { data, error } = await supabase.rpc('update_business_order_v3', {
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
    p_items: orderItemsPayload(input.items),
    p_payment_due_date: nullableText(input.payment_due_date),
    p_reason: nullableText(parsedReason.data),
    p_shop_id: input.shop_id,
    p_salesperson_id: input.salesperson_id,
    p_external_order_number: input.external_order_number,
    p_daily_shipping_date: input.daily_shipping_date,
    p_daily_shipping_number: nullableText(input.daily_shipping_number),
    p_daily_payment_category: input.daily_payment_category,
    p_total_product_received_amount: input.total_product_received_amount,
    p_total_product_received_overridden: input.total_product_received_overridden,
    p_total_shipping_received_amount: input.total_shipping_received_amount,
    p_total_shipping_received_overridden: input.total_shipping_received_overridden,
    p_total_sales_amount: input.total_sales_amount,
    p_total_sales_overridden: input.total_sales_overridden,
  })

  if (error) return { ok: false, error: businessOrderError(error.message, '更新业务订单失败') }
  const order = parseRpcOrder(data)
  if (!order) return { ok: false, error: '数据库未返回订单信息' }

  revalidateBusinessOrders(id)
  return { ok: true, ...order }
}

export async function bindBusinessOrderAttachment(
  rawInput: unknown,
): Promise<BusinessOrderAttachmentActionResult> {
  const profile = await requireApproved()
  if (!['sales', 'supervisor', 'admin'].includes(profile.role)) {
    return { ok: false, error: '仅业务员、业务主管或管理员可以绑定订单附件' }
  }

  const parsed = businessOrderAttachmentInputSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  const input = parsed.data
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('bind_business_order_attachment', {
    p_order_id: input.order_id,
    p_object_path: input.object_path,
    p_original_name: nullableText(input.original_name),
    p_mime_type: input.mime_type,
    p_size_bytes: input.size_bytes,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '绑定订单附件失败') }

  const attachment = firstRpcRow<BusinessOrderAttachment>(data)
  if (!attachment) return { ok: false, error: '数据库未返回订单附件信息' }
  revalidateBusinessOrders(attachment.order_id)
  return { ok: true, attachment }
}

export async function getBusinessOrderAttachmentUrl(
  attachmentId: string,
): Promise<{ url?: string; error?: string }> {
  await requireApproved()
  const parsedId = z.string().uuid('附件 ID 不合法').safeParse(attachmentId)
  if (!parsedId.success) return { error: firstValidationError(parsedId.error) }

  const supabase = await createClient()
  const { data: attachment, error } = await supabase
    .from('business_order_attachments')
    .select('object_path')
    .eq('id', parsedId.data)
    .eq('status', 'active')
    .single()
  if (error || !attachment?.object_path) return { error: '订单附件不存在或无权查看' }

  const admin = createAdminClient()
  const { data: signed, error: signError } = await admin.storage
    .from('finance-daily-order-screenshots')
    .createSignedUrl(attachment.object_path, 60 * 10)
  if (signError) return { error: '生成订单附件链接失败' }
  return { url: signed.signedUrl }
}

export async function removeBusinessOrderAttachment(
  attachmentId: string,
): Promise<BusinessOrderAttachmentActionResult> {
  const profile = await requireApproved()
  if (!['sales', 'supervisor', 'admin'].includes(profile.role)) {
    return { ok: false, error: '仅业务员、业务主管或管理员可以移除订单附件' }
  }
  const parsedId = z.string().uuid('附件 ID 不合法').safeParse(attachmentId)
  if (!parsedId.success) return { ok: false, error: firstValidationError(parsedId.error) }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('remove_business_order_attachment', {
    p_attachment_id: parsedId.data,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '移除订单附件失败') }

  const attachment = firstRpcRow<BusinessOrderAttachment>(data)
  if (!attachment) return { ok: false, error: '数据库未返回订单附件信息' }
  revalidateBusinessOrders(attachment.order_id)
  return { ok: true, attachment }
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

export async function listBusinessCustomProductsLibrary(
  rawFilters: unknown = {},
): Promise<BusinessCustomProductLibraryResult> {
  await requireApproved()
  const parsed = businessCustomProductLibraryFilterSchema.safeParse(rawFilters)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('list_business_custom_products_library', {
    p_search: nullableText(parsed.data.search),
    p_customer_id: parsed.data.customer_id ?? null,
    p_scope: parsed.data.scope,
    p_status: parsed.data.status,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '读取定制产品库失败') }

  return { ok: true, data: (data ?? []) as BusinessCustomProductLibraryItem[] }
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

export async function createBusinessOrderReturn(
  orderId: string,
  rawInput: unknown,
): Promise<BusinessOrderReturnActionResult> {
  await requireFinanceAccess()
  const parsedOrderId = z.string().uuid('请选择有效订单').safeParse(orderId)
  if (!parsedOrderId.success) return { ok: false, error: firstValidationError(parsedOrderId.error) }

  const parsed = businessOrderReturnInputSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }
  const input = parsed.data

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('create_business_order_return', {
    p_order_id: parsedOrderId.data,
    p_returned_at: new Date(input.returned_at).toISOString(),
    p_notes: nullableText(input.notes),
    p_items: input.items,
    p_idempotency_key: input.idempotency_key,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '登记退货失败') }

  const result = firstRpcRow<{
    return: BusinessOrderReturn
    items: BusinessOrderReturnItem[]
  }>(data)
  if (!result?.return) return { ok: false, error: '数据库未返回退货记录' }

  revalidateBusinessOrders(parsedOrderId.data)
  return { ok: true, return: result.return, items: result.items ?? [] }
}

export async function voidBusinessOrderReturn(
  returnId: string,
  reason: string,
): Promise<ActionResult> {
  await requireFinanceAccess()
  const parsed = businessOrderReturnVoidInputSchema.safeParse({ return_id: returnId, reason })
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('void_business_order_return', {
    p_return_id: parsed.data.return_id,
    p_reason: parsed.data.reason,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '作废退货失败') }

  const orderReturn = firstRpcRow<BusinessOrderReturn>(data)
  revalidateBusinessOrders(orderReturn?.order_id)
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

export async function getBusinessOrderEditConstraints(
  orderId: string,
): Promise<BusinessOrderEditConstraintsResult> {
  await requireApproved()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('get_business_order_edit_constraints', {
    p_order_id: orderId,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '读取订单编辑约束失败') }

  const constraints = firstRpcRow<BusinessOrderEditConstraints>(data)
  if (!constraints) return { ok: false, error: '订单编辑约束不存在' }
  return { ok: true, data: constraints }
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

export async function closeBusinessOrderSpecial(
  orderId: string,
  expectedVersion: number,
  reason: string,
): Promise<BusinessOrderActionResult> {
  await requireAdmin()
  const parsed = businessOrderSpecialCloseInputSchema.safeParse({
    order_id: orderId,
    reason,
    expected_version: expectedVersion,
  })
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('close_business_order_special', {
    p_order_id: parsed.data.order_id,
    p_reason: parsed.data.reason,
    p_expected_version: parsed.data.expected_version,
  })
  if (error) return { ok: false, error: businessOrderError(error.message, '特殊关闭订单失败') }

  const order = parseRpcOrder(data)
  if (!order) return { ok: false, error: '数据库未返回关闭后的订单信息' }
  revalidateBusinessOrders(order.id)
  return { ok: true, ...order }
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
  if (!['sales', 'supervisor', 'admin'].includes(profile.role)) {
    return { ok: false, error: '仅业务员、业务主管或管理员可以提交订单' }
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
  if (profile.role !== 'finance') {
    return { ok: false, error: '仅财务可以填写订单核算信息' }
  }
  const parsed = businessOrderFinanceSchema.safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: firstValidationError(parsed.error) }

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
