import type { CommissionRule, CommissionRuleLine } from '@/types'

/** 规则条件上下文：不可得的数值（未关联客户 / 非成交单）用 null 表示，此类规则视为未命中。 */
export interface CommissionRuleContext {
  tagColor: string | null
  /** 业务线传产品行分类；运营线传订单内出现过的分类集合。 */
  shippingCategory: string | string[] | null
  customOrderCount: number | null
  orderIndex: number | null
  tenureMonths: number | null
}

export interface CommissionRuleMatch {
  rule: CommissionRule
  rate: number
}

export function sortCommissionRules(rules: CommissionRule[]): CommissionRule[] {
  return [...rules].sort(
    (left, right) =>
      left.priority - right.priority ||
      left.created_at.localeCompare(right.created_at) ||
      left.id.localeCompare(right.id),
  )
}

/**
 * 同一条线内按 priority 逐条匹配，第一条全部条件命中的规则即生效；
 * 规则的条件全部为空时视为兜底规则。未命中返回 null（继续匹配由本函数内部完成）。
 */
export function matchCommissionRule(
  rules: CommissionRule[],
  ctx: CommissionRuleContext,
): CommissionRuleMatch | null {
  for (const rule of rules) {
    if (!rule.enabled) continue
    if (rule.tag_color && rule.tag_color !== ctx.tagColor) continue
    if (rule.shipping_category) {
      const categories = Array.isArray(ctx.shippingCategory)
        ? ctx.shippingCategory
        : ctx.shippingCategory
          ? [ctx.shippingCategory]
          : []
      if (!categories.includes(rule.shipping_category)) continue
    }
    if (
      rule.custom_order_count_max !== null &&
      (ctx.customOrderCount === null || ctx.customOrderCount > rule.custom_order_count_max)
    ) {
      continue
    }
    if (
      rule.order_index_max !== null &&
      (ctx.orderIndex === null || ctx.orderIndex > rule.order_index_max)
    ) {
      continue
    }
    if (
      rule.tenure_months_max !== null &&
      (ctx.tenureMonths === null || ctx.tenureMonths > rule.tenure_months_max)
    ) {
      continue
    }
    return { rule, rate: rule.product_commission_rate }
  }
  return null
}

const SHIPPING_CATEGORY_LABELS: Record<string, string> = {
  stock: '现货',
  sample: '现货样品',
  custom_sample: '定制打样',
  custom: '定制',
  purchase: '外采',
}

/** 规则条件的人类可读描述，用于设置页与提成表悬浮提示。 */
export function describeCommissionRuleConditions(
  rule: CommissionRule,
  tagLabels?: Record<string, string>,
): string[] {
  const parts: string[] = []
  if (rule.tag_color) {
    parts.push(`客户标记：${tagLabels?.[rule.tag_color] ?? rule.tag_color}`)
  }
  if (rule.shipping_category) {
    parts.push(`发货分类：${SHIPPING_CATEGORY_LABELS[rule.shipping_category] ?? rule.shipping_category}`)
  }
  if (rule.custom_order_count_max !== null) {
    parts.push(`累计定制订单 ≤ ${rule.custom_order_count_max} 单`)
  }
  if (rule.order_index_max !== null) parts.push(`客户前 ${rule.order_index_max} 单`)
  if (rule.tenure_months_max !== null) {
    parts.push(
      rule.tenure_months_max % 12 === 0
        ? `客户年限 ≤ ${rule.tenure_months_max / 12} 年`
        : `客户年限 ≤ ${rule.tenure_months_max} 个月`,
    )
  }
  return parts.length > 0 ? parts : ['全部订单（兜底）']
}

export function filterRulesByLine(rules: CommissionRule[], line: CommissionRuleLine): CommissionRule[] {
  return sortCommissionRules(rules.filter((rule) => rule.line === line))
}
