'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin, requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import {
  financeReimbursementRequestSchema,
  financeReimbursementReviewSchema,
} from '@/schemas/finance'
import type { ActionResult } from './products'

function revalidateReimbursement() {
  revalidatePath('/reimbursement')
}

// 客户端上传后回传的凭证路径，首级目录必须是本人 uid，防止引用他人凭证图
function assertOwnReceipts(receiptPaths: (string | null)[], applicantId: string): string | null {
  for (const path of receiptPaths) {
    if (path && !path.startsWith(`${applicantId}/`)) return '凭证图片归属不符，请重新上传'
  }
  return null
}

// 尽力清理不再被引用的凭证文件；失败不阻断主流程（如已删行导致对象不存在）
async function removeReceiptsQuietly(supabase: Awaited<ReturnType<typeof createClient>>, paths: string[]) {
  if (paths.length === 0) return
  await supabase.storage.from('finance-reimbursement-receipts').remove(paths)
}

export async function createReimbursementRequest(input: unknown): Promise<ActionResult> {
  const profile = await requireApproved()
  const parsed = financeReimbursementRequestSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const receiptCheck = assertOwnReceipts(
    parsed.data.items.map((item) => item.receipt_path),
    profile.id,
  )
  if (receiptCheck) return { ok: false, error: receiptCheck }

  const supabase = await createClient()
  const { data: request, error: requestError } = await supabase
    .from('finance_reimbursement_requests')
    .insert({
      applicant_id: profile.id,
      expense_date: parsed.data.expense_date,
      project_name: parsed.data.project_name || null,
    })
    .select('id')
    .single()
  if (requestError || !request) {
    return { ok: false, error: requestError?.message ?? '创建报销单失败' }
  }

  const { error: itemsError } = await supabase.from('finance_reimbursement_items').insert(
    parsed.data.items.map((item, index) => ({
      request_id: request.id,
      summary: item.summary,
      unit_price: item.unit_price,
      quantity: item.quantity,
      receipt_path: item.receipt_path,
      sort_order: index,
    })),
  )
  if (itemsError) {
    // 明细写入失败时整单回滚，避免留下无明细的孤儿单
    await supabase.from('finance_reimbursement_requests').delete().eq('id', request.id)
    await removeReceiptsQuietly(
      supabase,
      parsed.data.items
        .map((item) => item.receipt_path)
        .filter((path): path is string => !!path),
    )
    return { ok: false, error: itemsError.message }
  }

  revalidateReimbursement()
  return { ok: true }
}

export async function updateReimbursementRequest(
  requestId: string,
  input: unknown,
): Promise<ActionResult> {
  await requireApproved()
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return { ok: false, error: '报销单 ID 无效' }
  const parsed = financeReimbursementRequestSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { data: existing, error: loadError } = await supabase
    .from('finance_reimbursement_requests')
    .select('id, applicant_id, status')
    .eq('id', requestId)
    .maybeSingle()
  if (loadError) return { ok: false, error: loadError.message }
  if (!existing) return { ok: false, error: '报销单不存在或无权限' }

  const receiptCheck = assertOwnReceipts(
    parsed.data.items.map((item) => item.receipt_path),
    existing.applicant_id,
  )
  if (receiptCheck) return { ok: false, error: receiptCheck }

  // 记录旧凭证路径，保存成功后清理不再被引用的文件
  const { data: oldItems } = await supabase
    .from('finance_reimbursement_items')
    .select('receipt_path')
    .eq('request_id', requestId)

  const { error: updateError } = await supabase
    .from('finance_reimbursement_requests')
    .update({
      expense_date: parsed.data.expense_date,
      project_name: parsed.data.project_name || null,
    })
    .eq('id', requestId)
  if (updateError) return { ok: false, error: updateError.message }

  const { error: deleteError } = await supabase
    .from('finance_reimbursement_items')
    .delete()
    .eq('request_id', requestId)
  if (deleteError) return { ok: false, error: deleteError.message }

  const { error: itemsError } = await supabase.from('finance_reimbursement_items').insert(
    parsed.data.items.map((item, index) => ({
      request_id: requestId,
      summary: item.summary,
      unit_price: item.unit_price,
      quantity: item.quantity,
      receipt_path: item.receipt_path,
      sort_order: index,
    })),
  )
  if (itemsError) return { ok: false, error: itemsError.message }

  // 被驳回的单保存修改后自动回到待审批
  if (existing.status === 'rejected') {
    const { error: resubmitError } = await supabase
      .from('finance_reimbursement_requests')
      .update({ status: 'pending' })
      .eq('id', requestId)
      .eq('status', 'rejected')
    if (resubmitError) return { ok: false, error: resubmitError.message }
  }

  const newReceiptPaths = new Set(
    parsed.data.items.map((item) => item.receipt_path).filter((path): path is string => !!path),
  )
  const orphanedReceipts = (oldItems ?? [])
    .map((item) => item.receipt_path)
    .filter((path): path is string => !!path && !newReceiptPaths.has(path))
  await removeReceiptsQuietly(supabase, orphanedReceipts)

  revalidateReimbursement()
  return { ok: true }
}

export async function deleteReimbursementRequest(requestId: string): Promise<ActionResult> {
  await requireApproved()
  const supabase = await createClient()
  // 明细随单级联删除，需先取出凭证路径用于事后清理
  const { data: oldItems } = await supabase
    .from('finance_reimbursement_items')
    .select('receipt_path')
    .eq('request_id', requestId)
  const { data, error } = await supabase
    .from('finance_reimbursement_requests')
    .delete()
    .eq('id', requestId)
    .select('id')
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: '报销单不存在或当前状态不可删除' }
  await removeReceiptsQuietly(
    supabase,
    (oldItems ?? [])
      .map((item) => item.receipt_path)
      .filter((path): path is string => !!path),
  )
  revalidateReimbursement()
  return { ok: true }
}

export async function reviewReimbursementRequest(input: unknown): Promise<ActionResult> {
  await requireAdmin()
  const parsed = financeReimbursementReviewSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }
  if (parsed.data.decision === 'reject' && !parsed.data.reject_reason) {
    return { ok: false, error: '驳回必须填写原因' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('finance_reimbursement_requests')
    .update(
      parsed.data.decision === 'approve'
        ? { status: 'approved' }
        : { status: 'rejected', reject_reason: parsed.data.reject_reason },
    )
    .eq('id', parsed.data.request_id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: '报销单不存在或已不在待审批状态' }
  revalidateReimbursement()
  return { ok: true }
}

export async function completeReimbursementRequest(requestId: string): Promise<ActionResult> {
  await requireAdmin()
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('finance_reimbursement_requests')
    .update({ status: 'completed' })
    .eq('id', requestId)
    .eq('status', 'approved')
    .select('id')
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: '报销单不存在或已不在已通过状态' }
  revalidateReimbursement()
  return { ok: true }
}
