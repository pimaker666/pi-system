import type { OperatorCommissionRow, OperatorCommissionSummaryTotal, OperatorRateMode } from '@/types'

export const OPERATOR_COMMISSION_COLUMNS = [
  '订单日期',
  '订单号',
  '店铺',
  '客户',
  '业务员',
  '运营',
  '份额',
  '产品实收金额',
  '运营提点',
  '运营提成',
  '结清状态',
] as const

export const OPERATOR_COMMISSION_PAGE_SIZE = 50

export interface OperatorRuleInput {
  operator_id: string
  share_percent: number
  product_commission_rate: number
  /** fixed=固定点数；rules=按运营规则线逐条匹配。 */
  rate_mode: OperatorRateMode
}

export interface ResolvedOrderOperator extends OperatorRuleInput {
  has_assignment: boolean
}

/**
 * 订单 → 运营归属。
 * 订单级指定即替代：只要订单有指定记录，就不再叠加店铺规则，避免同一单重复发放。
 * 没有指定时回落到订单所属店铺的运营规则。
 */
export function resolveOrderOperators(
  shopId: string | null,
  assignments: OperatorRuleInput[],
  shopRules: OperatorRuleInput[],
): ResolvedOrderOperator[] {
  if (assignments.length > 0) {
    return assignments.map((row) => ({ ...row, has_assignment: true }))
  }
  if (!shopId) return []
  return shopRules.map((row) => ({ ...row, has_assignment: false }))
}

/** 运营提成（原币）= 产品实收 × 提点% × 本人份额%。份额按人独立，不要求合计 100%。 */
export function calculateOperatorCommission(
  productReceivedAmount: number,
  ratePercent: number,
  sharePercent: number,
) {
  return Math.round(((productReceivedAmount * ratePercent) / 100) * (sharePercent / 100) * 10000) / 10000
}

/** 已确认结清行按「运营人 + 结清归属月」汇总；美元行按结清时锁定的汇率折算。 */
export function summarizeOperatorCommission(
  rows: OperatorCommissionRow[],
): OperatorCommissionSummaryTotal[] {
  const totals = new Map<string, OperatorCommissionSummaryTotal>()
  for (const row of rows) {
    if (row.clearance_status !== 'confirmed' || !row.clearance_period) continue
    const key = `${row.operator_name}\u0000${row.clearance_period}`
    const total = totals.get(key) ?? {
      operatorName: row.operator_name,
      period: row.clearance_period,
      amount: 0,
      missingRateCount: 0,
    }
    const rate = row.currency === 'USD' ? row.settlement_exchange_rate_to_cny : 1
    if (rate == null) total.missingRateCount += 1
    else total.amount += row.commission_amount * rate
    totals.set(key, total)
  }
  return [...totals.values()]
    .map((total) => ({ ...total, amount: Math.round(total.amount * 10000) / 10000 }))
    .sort(
      (left, right) =>
        right.period.localeCompare(left.period) ||
        left.operatorName.localeCompare(right.operatorName, 'zh-CN'),
    )
}
