import type { SupabaseClient } from '@supabase/supabase-js'
import type { CommissionRule, CommissionRuleLine } from '@/types'
import { sortCommissionRules } from '@/lib/commission-rules'

const ID_CHUNK = 100

/** 订单时点上下文（按订单下单时点计算，历史值不会随新订单变化）。 */
export interface CommissionOrderContext {
  /** 客户第 N 单（仅成交单计入），非成交单为 null。 */
  orderIndex: number | null
  /** 客户年限（月），无成交单或未关联客户时为 null。 */
  tenureMonths: number | null
}

interface CommissionRuleRow extends Omit<CommissionRule, 'product_commission_rate'> {
  product_commission_rate: number | string
}

/** 读取某条提成线的全部规则（含停用），已按 priority 升序排好。 */
export async function fetchCommissionRules(
  supabase: SupabaseClient,
  line: CommissionRuleLine,
): Promise<CommissionRule[]> {
  const { data, error } = await supabase
    .from('finance_commission_rules')
    .select('*')
    .eq('line', line)
  if (error) throw new Error(`提成规则读取失败：${error.message}`)
  return sortCommissionRules(
    ((data ?? []) as CommissionRuleRow[]).map((row) => ({
      ...row,
      product_commission_rate: Number(row.product_commission_rate),
    })),
  )
}

export async function fetchCommissionOrderContext(
  supabase: SupabaseClient,
  orderIds: string[],
): Promise<Map<string, CommissionOrderContext>> {
  const contexts = new Map<string, CommissionOrderContext>()
  const unique = [...new Set(orderIds)]
  for (let index = 0; index < unique.length; index += ID_CHUNK) {
    const chunk = unique.slice(index, index + ID_CHUNK)
    const { data, error } = await supabase.rpc('get_business_order_commission_context', {
      p_order_ids: chunk,
    })
    if (error) throw new Error(`订单提成上下文读取失败：${error.message}`)
    for (const row of (data ?? []) as Array<{
      order_id: string
      customer_order_index: number | string | null
      tenure_months: number | string | null
    }>) {
      contexts.set(row.order_id, {
        orderIndex: row.customer_order_index == null ? null : Number(row.customer_order_index),
        tenureMonths: row.tenure_months == null ? null : Number(row.tenure_months),
      })
    }
  }
  return contexts
}
