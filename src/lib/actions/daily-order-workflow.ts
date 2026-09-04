'use server'

import { revalidatePath } from 'next/cache'
import { requireApproved, requireFinanceAccess } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import {
  bindWorkflowCustomerSchema,
  cancelChangeSchema,
  claimWorkflowSchema,
  requestChangeSchema,
  reviewChangeSchema,
  reviewPerformanceSchema,
  saveCommissionSchema,
  submitPerformanceSchema,
} from '@/schemas/daily-order-workflow'
import type { ActionResult } from './products'

export interface WorkflowActionResult extends ActionResult {
  version?: number
  id?: string
}

function firstError(error: { issues: Array<{ message: string }> }) {
  return error.issues[0]?.message ?? '数据校验失败'
}

function mapError(message: string) {
  const errors: Array<[string, string]> = [
    ['Only approved sales users', '仅已审核的业务员可执行此操作'],
    ['Only approved admin or finance', '仅已审核的管理员或财务可操作'],
    ['Only sales, finance, or admin', '仅业务、财务或管理员可绑定客户'],
    ['Authentication required', '请先登录'],
    ['Account is not approved', '账号未审核'],
    ['Workflow does not exist', '订单工作流不存在'],
    ['This order does not belong to you', '该订单不属于你'],
    ['Workflow version conflict', '订单已被他人修改，请刷新后重试'],
    ['Order has already been claimed', '订单已被认领'],
    ['Only claimed or rejected orders can be submitted', '仅已认领或被驳回的订单可提交'],
    ['Bind a customer before submitting', '提交前请先绑定客户'],
    ['Customer can only be bound after claiming', '认领后、审核通过前方可绑定客户'],
    ['Approved orders cannot rebind customers', '业绩已通过的订单不可重新绑定客户'],
    ['Customer does not exist', '客户不存在'],
    ['Only submitted orders can be reviewed', '仅已提交的订单可审核'],
    ['A reason is required to reject', '驳回时必须填写原因'],
    ['Reason is too long', '原因过长'],
    ['Commission can only be recorded after performance approval', '仅业绩通过后可录入提成'],
    ['Commission amount must be', '提成金额必须为非负且最多 2 位小数'],
    ['Unsupported commission currency', '不支持的提成币种'],
    ['Change payload must be a JSON object', '改动内容格式错误'],
    ['Change payload cannot be empty', '请至少修改一个字段'],
    ['Change payload contains unsupported fields', '改动包含不允许修改的字段'],
    ['Quantity must be positive', '数量必须为正且最多 4 位小数'],
    ['Amounts must be non-negative', '金额必须为非负且最多 2 位小数'],
    ['Unsupported currency', '不支持的币种'],
    ['Shipping number is too long', '物流单号过长'],
    ['Remarks are too long', '备注过长'],
    ['Daily order does not exist', '订单行不存在'],
    ['Voided order cannot be changed', '已作废订单不可修改'],
    ['Order has no workflow', '订单缺少归属工作流'],
    ['Claim the order before requesting changes', '请先认领订单再申请改动'],
    ['A pending change request already exists', '该订单行已有待审改动，请先处理'],
    ['Change request does not exist', '改动申请不存在'],
    ['Change request is no longer pending', '改动申请已被处理'],
    ['Only pending change requests can be cancelled', '仅待审的改动申请可撤销'],
    ['This change request does not belong to you', '该改动申请不属于你'],
  ]
  return errors.find(([source]) => message.includes(source))?.[1] ?? message
}

function revalidateWorkflow() {
  revalidatePath('/finance/performance')
  revalidatePath('/finance/performance/orders')
  revalidatePath('/finance/daily-orders')
  revalidatePath('/finance/daily-orders/review')
}

export async function claimDailyOrderWorkflow(raw: unknown): Promise<WorkflowActionResult> {
  await requireApproved()
  const parsed = claimWorkflowSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('claim_daily_order_workflow', {
    p_workflow_id: parsed.data.workflowId,
    p_expected_version: parsed.data.expectedVersion,
  })
  if (error) return { ok: false, error: mapError(error.message) }
  revalidateWorkflow()
  return { ok: true, version: (data as { version?: number } | null)?.version }
}

export async function bindDailyOrderWorkflowCustomer(
  raw: unknown,
): Promise<WorkflowActionResult> {
  await requireApproved()
  const parsed = bindWorkflowCustomerSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('bind_daily_order_workflow_customer', {
    p_workflow_id: parsed.data.workflowId,
    p_expected_version: parsed.data.expectedVersion,
    p_customer_id: parsed.data.customerId,
  })
  if (error) return { ok: false, error: mapError(error.message) }
  revalidateWorkflow()
  return { ok: true, version: (data as { version?: number } | null)?.version }
}

export async function submitDailyOrderPerformance(
  raw: unknown,
): Promise<WorkflowActionResult> {
  await requireApproved()
  const parsed = submitPerformanceSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('submit_daily_order_performance', {
    p_workflow_id: parsed.data.workflowId,
    p_expected_version: parsed.data.expectedVersion,
  })
  if (error) return { ok: false, error: mapError(error.message) }
  revalidateWorkflow()
  return { ok: true, version: (data as { version?: number } | null)?.version }
}

export async function reviewDailyOrderPerformance(
  raw: unknown,
): Promise<WorkflowActionResult> {
  await requireFinanceAccess()
  const parsed = reviewPerformanceSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('review_daily_order_performance', {
    p_workflow_id: parsed.data.workflowId,
    p_expected_version: parsed.data.expectedVersion,
    p_approve: parsed.data.approve,
    p_reason: parsed.data.approve ? null : parsed.data.reason,
  })
  if (error) return { ok: false, error: mapError(error.message) }
  revalidateWorkflow()
  return { ok: true, version: (data as { version?: number } | null)?.version }
}

export async function saveDailyOrderCommission(raw: unknown): Promise<WorkflowActionResult> {
  await requireFinanceAccess()
  const parsed = saveCommissionSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('save_daily_order_commission', {
    p_workflow_id: parsed.data.workflowId,
    p_commission_amount: parsed.data.commissionAmount,
    p_commission_currency: parsed.data.commissionCurrency,
    p_remarks: parsed.data.remarks || null,
  })
  if (error) return { ok: false, error: mapError(error.message) }
  revalidateWorkflow()
  return { ok: true, id: (data as { id?: string } | null)?.id }
}

export async function requestDailyOrderChange(raw: unknown): Promise<WorkflowActionResult> {
  await requireApproved()
  const parsed = requestChangeSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('request_daily_order_change', {
    p_order_id: parsed.data.orderId,
    p_payload: parsed.data.payload,
  })
  if (error) return { ok: false, error: mapError(error.message) }
  revalidateWorkflow()
  return { ok: true, id: (data as { id?: string } | null)?.id }
}

export async function reviewDailyOrderChange(raw: unknown): Promise<WorkflowActionResult> {
  await requireFinanceAccess()
  const parsed = reviewChangeSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('review_daily_order_change', {
    p_change_id: parsed.data.changeId,
    p_approve: parsed.data.approve,
    p_reason: parsed.data.approve ? null : parsed.data.reason,
  })
  if (error) return { ok: false, error: mapError(error.message) }
  revalidateWorkflow()
  return { ok: true, id: (data as { id?: string } | null)?.id }
}

export async function cancelDailyOrderChange(raw: unknown): Promise<WorkflowActionResult> {
  await requireApproved()
  const parsed = cancelChangeSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('cancel_daily_order_change', {
    p_change_id: parsed.data.changeId,
  })
  if (error) return { ok: false, error: mapError(error.message) }
  revalidateWorkflow()
  return { ok: true, id: (data as { id?: string } | null)?.id }
}
