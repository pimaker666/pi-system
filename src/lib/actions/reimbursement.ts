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

// 尽力清理不再被引用的凭证文件；失败不阻断已成功提交的数据库事务。
async function removeReceiptsQuietly(supabase: Awaited<ReturnType<typeof createClient>>, paths: string[]) {
  if (paths.length === 0) return
  try {
    await supabase.storage.from('finance-reimbursement-receipts').remove(paths)
  } catch {}
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
  const { data, error } = await supabase.rpc('save_finance_reimbursement_request', {
    p_request_id: null,
    p_expense_date: parsed.data.expense_date,
    p_project_name: parsed.data.project_name || null,
    p_items: parsed.data.items,
  })
  // 保存失败保留用户已上传的凭证，以便重试；不做跨请求补偿删除。
  if (error || !data?.request_id) return { ok: false, error: error?.message ?? '创建报销单失败' }
  await removeReceiptsQuietly(supabase, data.receipt_paths ?? [])

  revalidateReimbursement()
  return { ok: true }
}

export async function updateReimbursementRequest(
  requestId: string,
  input: unknown,
): Promise<ActionResult> {
  const profile = await requireApproved()
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return { ok: false, error: '报销单 ID 无效' }
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
  const { data, error } = await supabase.rpc('save_finance_reimbursement_request', {
    p_request_id: requestId,
    p_expense_date: parsed.data.expense_date,
    p_project_name: parsed.data.project_name || null,
    p_items: parsed.data.items,
  })
  if (error || !data?.request_id) return { ok: false, error: error?.message ?? '保存报销单失败' }
  await removeReceiptsQuietly(supabase, data.receipt_paths ?? [])

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
