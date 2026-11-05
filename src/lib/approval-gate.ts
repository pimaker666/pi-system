import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  ApprovalActionKey,
  ApprovalApprover,
  ApprovalMode,
  PendingApproval,
} from '@/types'

const APPROVAL_REQUIRED_PATTERN = /APPROVAL_REQUIRED:([A-Za-z0-9_.]+)/

/** 业务 RPC 被审批闸门拦下时，从错误信息里取回动作键。 */
export function approvalRequiredKey(message: string | null | undefined): ApprovalActionKey | null {
  const matched = APPROVAL_REQUIRED_PATTERN.exec(message ?? '')
  return (matched?.[1] as ApprovalActionKey | undefined) ?? null
}

interface ApprovalCheckResult {
  required?: boolean
  rule_name?: string
  mode?: ApprovalMode
  approvers?: ApprovalApprover[]
}

interface RequestApprovalInput {
  actionKey: ApprovalActionKey
  entityId: string
  payload: Record<string, unknown>
  summary: string
  amount?: number | null
}

export type RequestApprovalResult =
  | { ok: true; pendingApproval: PendingApproval }
  | { ok: false; error: string }

/**
 * 闸门拦下业务动作后，按同一规则创建审批单。
 * 金额由数据库对订单动作统一取库内总值，这里传入值只用于条件判定展示。
 */
export async function requestApprovalForAction(
  supabase: SupabaseClient,
  input: RequestApprovalInput,
): Promise<RequestApprovalResult> {
  const amount = input.amount ?? null
  const { data: checkData, error: checkError } = await supabase.rpc('approval_check', {
    p_action_key: input.actionKey,
    p_entity_id: input.entityId,
    p_amount: amount,
  })
  if (checkError) return { ok: false, error: checkError.message }

  const check = (checkData ?? {}) as ApprovalCheckResult
  if (!check.required) {
    return { ok: false, error: '当前操作已无需审批，请重试' }
  }

  const { data: requestId, error: createError } = await supabase.rpc('approval_request_create', {
    p_action_key: input.actionKey,
    p_entity_type: 'business_order',
    p_entity_id: input.entityId,
    p_payload: input.payload,
    p_summary: input.summary,
    p_amount: amount,
  })
  if (createError || !requestId) {
    return { ok: false, error: createError?.message ?? '提交审批失败' }
  }

  return {
    ok: true,
    pendingApproval: {
      requestId: requestId as string,
      actionKey: input.actionKey,
      actionName: check.rule_name ?? input.actionKey,
      mode: check.mode ?? 'any',
      approvers: check.approvers ?? [],
    },
  }
}

export function pendingApprovalMessage(pending: PendingApproval) {
  const approverNames = pending.approvers.map((approver) => approver.name).join('、')
  return approverNames
    ? `已提交「${pending.actionName}」审批，待 ${approverNames} 处理，通过后自动执行`
    : `已提交「${pending.actionName}」审批，通过后自动执行`
}
