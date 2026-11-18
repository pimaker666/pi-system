'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireApproved, requireFinanceAccess } from '@/lib/auth'
import { resolveOrderOperators, type OperatorRuleInput } from '@/lib/operator-commission'
import type { ActionResult } from './products'

const CHUNK_SIZE = 100

function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = []
  for (let index = 0; index < ids.length; index += CHUNK_SIZE) {
    chunks.push(ids.slice(index, index + CHUNK_SIZE))
  }
  return chunks
}

const percentRate = z
  .number({ invalid_type_error: '提点必须是数字' })
  .min(0, '提点不能为负')
  .max(100, '提点不能超过 100')
  .refine((value) => value === Math.round(value * 10000) / 10000, '提点最多保留 4 位小数')

// 份额按人独立：既可以多人合计 100% 分摊，也可以每人各拿 100%。
const sharePercent = z
  .number({ invalid_type_error: '份额必须是数字' })
  .gt(0, '份额必须大于 0')
  .max(100, '份额不能超过 100')
  .refine((value) => value === Math.round(value * 10000) / 10000, '份额最多保留 4 位小数')

const operatorRuleSchema = z.object({
  operator_id: z.string().uuid('运营人员 ID 无效'),
  share_percent: sharePercent,
  product_commission_rate: percentRate,
  rate_mode: z.enum(['fixed', 'rules']).default('fixed'),
})

const shopOperatorRulesSchema = z.object({
  shop_id: z.string().uuid('店铺 ID 无效'),
  rules: z.array(operatorRuleSchema).max(50, '单个店铺最多配置 50 位运营'),
})

const orderOperatorAssignmentsSchema = z.object({
  business_order_id: z.string().uuid('订单 ID 无效'),
  rules: z.array(operatorRuleSchema).max(50, '单个订单最多指定 50 位运营'),
})

const clearanceItemSchema = z.object({
  business_order_id: z.string().uuid('订单 ID 无效'),
  operator_id: z.string().uuid('运营人员 ID 无效'),
})

const operatorClearanceSchema = z.object({
  items: z.array(clearanceItemSchema).min(1, '至少选择一条运营提成记录').max(500, '一次最多处理 500 条'),
  period: z.string().regex(/^\d{4}-\d{2}$/, '结清月份格式应为 YYYY-MM'),
  direct: z.boolean().optional(),
})

const clearanceActionSchema = z.object({
  items: z.array(clearanceItemSchema).min(1, '至少选择一条运营提成记录').max(500, '一次最多处理 500 条'),
})

const clearanceRejectSchema = clearanceActionSchema.extend({
  reason: z.string().trim().min(1, '请填写驳回原因').max(500, '驳回原因最多 500 字'),
})

function revalidateOperatorCommission() {
  revalidatePath('/finance/commission')
  revalidatePath('/finance/my-commission')
}

function dedupeRules(rules: z.infer<typeof operatorRuleSchema>[]): z.infer<typeof operatorRuleSchema>[] {
  const map = new Map<string, z.infer<typeof operatorRuleSchema>>()
  for (const rule of rules) map.set(rule.operator_id, rule)
  return [...map.values()]
}

/** 运营只能由「运营」或「管理员」账号承担，与页面候选口径一致。 */
async function assertValidOperators(
  supabase: Awaited<ReturnType<typeof createClient>>,
  operatorIds: string[],
): Promise<ActionResult | null> {
  if (operatorIds.length === 0) return null
  const valid: string[] = []
  for (const chunk of chunkIds([...new Set(operatorIds)])) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id')
      .in('id', chunk)
      .eq('status', 'approved')
      .in('role', ['operations', 'admin'])
    if (error) return { ok: false, error: error.message }
    valid.push(...((data ?? []) as Array<{ id: string }>).map((row) => row.id))
  }
  if (valid.length !== new Set(operatorIds).size) {
    return { ok: false, error: '运营人员必须是已审批的运营或管理员账号' }
  }
  return null
}

/** 保存店铺运营规则：先写入新规则，再清理被移除的运营，避免中途失败使整店规则消失。 */
export async function saveShopOperatorRules(input: {
  shop_id: string
  rules: Array<{ operator_id: string; share_percent: number; product_commission_rate: number; rate_mode?: 'fixed' | 'rules' }>
}): Promise<ActionResult> {
  const profile = await requireFinanceAccess()
  const parsed = shopOperatorRulesSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }
  const supabase = await createClient()
  const rules = dedupeRules(parsed.data.rules)
  const invalidOperator = await assertValidOperators(supabase, rules.map((rule) => rule.operator_id))
  if (invalidOperator) return invalidOperator

  const now = new Date().toISOString()
  if (rules.length > 0) {
    const { error } = await supabase.from('finance_shop_operator_rules').upsert(
      rules.map((rule) => ({
        shop_id: parsed.data.shop_id,
        operator_id: rule.operator_id,
        share_percent: rule.share_percent,
        product_commission_rate: rule.product_commission_rate,
        rate_mode: rule.rate_mode,
        created_by: profile.id,
        updated_at: now,
      })),
      { onConflict: 'shop_id,operator_id' },
    )
    if (error) return { ok: false, error: error.message }
  }

  const { data: existing, error: existingError } = await supabase
    .from('finance_shop_operator_rules')
    .select('id, operator_id')
    .eq('shop_id', parsed.data.shop_id)
  if (existingError) return { ok: false, error: existingError.message }
  const keep = new Set(rules.map((rule) => rule.operator_id))
  const removeIds = ((existing ?? []) as Array<{ id: string; operator_id: string }>)
    .filter((row) => !keep.has(row.operator_id))
    .map((row) => row.id)
  for (const chunk of chunkIds(removeIds)) {
    const { error } = await supabase.from('finance_shop_operator_rules').delete().in('id', chunk)
    if (error) return { ok: false, error: error.message }
  }

  revalidateOperatorCommission()
  return { ok: true }
}

/** 订单级指定运营：指定即替代店铺规则；传空数组即清除指定、恢复店铺规则。 */
export async function saveOrderOperatorAssignments(input: {
  business_order_id: string
  rules: Array<{ operator_id: string; share_percent: number; product_commission_rate: number; rate_mode?: 'fixed' | 'rules' }>
}): Promise<ActionResult> {
  const profile = await requireApproved()
  const parsed = orderOperatorAssignmentsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { data: order, error: orderError } = await supabase
    .from('business_orders')
    .select('id, salesperson_id, voided_at')
    .eq('id', parsed.data.business_order_id)
    .maybeSingle()
  if (orderError) return { ok: false, error: orderError.message }
  if (!order) return { ok: false, error: '订单不存在' }
  if (order.voided_at) return { ok: false, error: '已作废订单不能指定运营' }
  const canManage = profile.role === 'admin' || profile.role === 'finance'
  if (!canManage && order.salesperson_id !== profile.id) {
    return { ok: false, error: '只能为自己负责的订单指定运营' }
  }

  const rules = dedupeRules(parsed.data.rules)
  const invalidOperator = await assertValidOperators(supabase, rules.map((rule) => rule.operator_id))
  if (invalidOperator) return invalidOperator

  const now = new Date().toISOString()
  if (rules.length > 0) {
    const { error } = await supabase.from('finance_business_order_operator_assignments').upsert(
      rules.map((rule) => ({
        business_order_id: parsed.data.business_order_id,
        operator_id: rule.operator_id,
        share_percent: rule.share_percent,
        product_commission_rate: rule.product_commission_rate,
        rate_mode: rule.rate_mode,
        assigned_by: profile.id,
        updated_at: now,
      })),
      { onConflict: 'business_order_id,operator_id' },
    )
    if (error) return { ok: false, error: error.message }
  }

  const { data: existing, error: existingError } = await supabase
    .from('finance_business_order_operator_assignments')
    .select('id, operator_id')
    .eq('business_order_id', parsed.data.business_order_id)
  if (existingError) return { ok: false, error: existingError.message }
  const keep = new Set(rules.map((rule) => rule.operator_id))
  const removeIds = ((existing ?? []) as Array<{ id: string; operator_id: string }>)
    .filter((row) => !keep.has(row.operator_id))
    .map((row) => row.id)
  for (const chunk of chunkIds(removeIds)) {
    const { error } = await supabase
      .from('finance_business_order_operator_assignments')
      .delete()
      .in('id', chunk)
    if (error) return { ok: false, error: error.message }
  }

  revalidateOperatorCommission()
  return { ok: true }
}

interface PendingOrderRow {
  id: string
  currency: string
  status: string
  voided_at: string | null
  shop_id: string | null
}

function clearanceKey(orderId: string, operatorId: string) {
  return `${orderId}\u0000${operatorId}`
}

/**
 * 服务端核对「订单 × 运营人」归属是否成立：必须来自订单指定或该店铺规则。
 * 同时返回美元订单结清所需汇率（与业务提成共用 finance_business_order_commissions 的锁定汇率）。
 */
async function loadClearanceContext(
  supabase: Awaited<ReturnType<typeof createClient>>,
  items: Array<{ business_order_id: string; operator_id: string }>,
): Promise<
  | { ok: false; error: string }
  | {
      ok: true
      orders: Map<string, PendingOrderRow>
      exchangeRates: Map<string, number | null>
    }
> {
  const orderIds = [...new Set(items.map((item) => item.business_order_id))]
  const orders: PendingOrderRow[] = []
  for (const chunk of chunkIds(orderIds)) {
    const { data, error } = await supabase
      .from('business_orders')
      .select('id, currency, status, voided_at, shop_id')
      .in('id', chunk)
    if (error) return { ok: false, error: error.message }
    orders.push(...((data ?? []) as PendingOrderRow[]))
  }
  const orderMap = new Map(orders.map((order) => [order.id, order]))
  if (orderMap.size !== orderIds.length) return { ok: false, error: '部分订单不存在' }

  for (const order of orders) {
    if (order.voided_at || !['approved', 'completed'].includes(order.status)) {
      return { ok: false, error: '只有已审核且未作废的订单才能处理运营提成结清' }
    }
  }

  const assignments: Array<{ business_order_id: string; operator_id: string; share_percent: number; product_commission_rate: number; rate_mode: string | null }> = []
  for (const chunk of chunkIds(orderIds)) {
    const { data, error } = await supabase
      .from('finance_business_order_operator_assignments')
      .select('business_order_id, operator_id, share_percent, product_commission_rate, rate_mode')
      .in('business_order_id', chunk)
    if (error) return { ok: false, error: error.message }
    assignments.push(...(data ?? []))
  }

  const shopIds = [...new Set(orders.map((order) => order.shop_id).filter((id): id is string => !!id))]
  const shopRules: Array<{ shop_id: string; operator_id: string; share_percent: number; product_commission_rate: number; rate_mode: string | null }> = []
  for (const chunk of chunkIds(shopIds)) {
    const { data, error } = await supabase
      .from('finance_shop_operator_rules')
      .select('shop_id, operator_id, share_percent, product_commission_rate, rate_mode')
      .in('shop_id', chunk)
    if (error) return { ok: false, error: error.message }
    shopRules.push(...(data ?? []))
  }

  const assignmentsByOrder = new Map<string, OperatorRuleInput[]>()
  for (const row of assignments) {
    const list = assignmentsByOrder.get(row.business_order_id) ?? []
    list.push({
      operator_id: row.operator_id,
      share_percent: Number(row.share_percent),
      product_commission_rate: Number(row.product_commission_rate),
      rate_mode: row.rate_mode === 'rules' ? 'rules' : 'fixed',
    })
    assignmentsByOrder.set(row.business_order_id, list)
  }
  const rulesByShop = new Map<string, OperatorRuleInput[]>()
  for (const row of shopRules) {
    const list = rulesByShop.get(row.shop_id) ?? []
    list.push({
      operator_id: row.operator_id,
      share_percent: Number(row.share_percent),
      product_commission_rate: Number(row.product_commission_rate),
      rate_mode: row.rate_mode === 'rules' ? 'rules' : 'fixed',
    })
    rulesByShop.set(row.shop_id, list)
  }

  for (const item of items) {
    const order = orderMap.get(item.business_order_id) as PendingOrderRow
    const resolved = resolveOrderOperators(
      order.shop_id,
      assignmentsByOrder.get(order.id) ?? [],
      order.shop_id ? rulesByShop.get(order.shop_id) ?? [] : [],
    )
    if (!resolved.some((row) => row.operator_id === item.operator_id)) {
      return { ok: false, error: '部分运营归属已变更，请刷新页面后重新提交' }
    }
  }

  const exchangeRates = new Map<string, number | null>()
  const usdOrderIds = orders.filter((order) => order.currency === 'USD').map((order) => order.id)
  for (const chunk of chunkIds(usdOrderIds)) {
    const { data, error } = await supabase
      .from('finance_business_order_commissions')
      .select('business_order_id, settlement_exchange_rate_to_cny')
      .in('business_order_id', chunk)
    if (error) return { ok: false, error: error.message }
    for (const row of (data ?? []) as Array<{
      business_order_id: string
      settlement_exchange_rate_to_cny: number | null
    }>) {
      exchangeRates.set(
        row.business_order_id,
        row.settlement_exchange_rate_to_cny == null ? null : Number(row.settlement_exchange_rate_to_cny),
      )
    }
  }

  return { ok: true, orders: orderMap, exchangeRates }
}

/** 提交运营提成结清：财务/管理员可提交为待确认，direct 时直接确认并锁定美元汇率。 */
export async function submitOperatorCommissionClearance(input: {
  items: Array<{ business_order_id: string; operator_id: string }>
  period: string
  direct?: boolean
}): Promise<ActionResult> {
  const profile = await requireFinanceAccess()
  const parsed = operatorClearanceSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }
  const supabase = await createClient()

  const uniqueItems = [
    ...new Map(
      parsed.data.items.map((item) => [clearanceKey(item.business_order_id, item.operator_id), item]),
    ).values(),
  ]
  const context = await loadClearanceContext(supabase, uniqueItems)
  if (!context.ok) return { ok: false, error: context.error }

  const direct = parsed.data.direct === true
  const hasMissingRate = uniqueItems.some((item) => {
    const order = context.orders.get(item.business_order_id)
    if (order?.currency !== 'USD') return false
    const rate = context.exchangeRates.get(item.business_order_id)
    return rate == null || !Number.isFinite(rate) || rate <= 0
  })
  if (hasMissingRate) {
    return { ok: false, error: '美元订单请先保存美元兑人民币汇率，计算运营提成后再提交结清' }
  }

  // 已确认的记录不能被旧页面请求重新拉回待确认。
  for (const item of uniqueItems) {
    const { data, error } = await supabase
      .from('finance_business_order_operator_commission_clearances')
      .select('status')
      .eq('business_order_id', item.business_order_id)
      .eq('operator_id', item.operator_id)
      .maybeSingle()
    if (error) return { ok: false, error: error.message }
    if (data?.status === 'confirmed') {
      return { ok: false, error: '部分提成已结清，请刷新页面后再提交' }
    }
  }

  const now = new Date().toISOString()
  const periodDate = `${parsed.data.period}-01`
  const { error } = await supabase.from('finance_business_order_operator_commission_clearances').upsert(
    uniqueItems.map((item) => ({
      business_order_id: item.business_order_id,
      operator_id: item.operator_id,
      period: periodDate,
      status: (direct ? 'confirmed' : 'pending') as 'confirmed' | 'pending',
      settlement_exchange_rate_to_cny:
        context.orders.get(item.business_order_id)?.currency === 'USD'
          ? context.exchangeRates.get(item.business_order_id) ?? null
          : null,
      submitted_by: profile.id,
      submitted_at: now,
      confirmed_by: direct ? profile.id : null,
      confirmed_at: direct ? now : null,
      rejected_reason: null,
      updated_at: now,
    })),
    { onConflict: 'business_order_id,operator_id' },
  )
  if (error) return { ok: false, error: error.message }

  revalidateOperatorCommission()
  return { ok: true }
}

async function assertCanActOnOperatorClearances(
  operatorIds: string[],
  profile: { id: string; role: string },
): Promise<ActionResult | null> {
  const isFinanceOrAdmin = profile.role === 'admin' || profile.role === 'finance'
  if (isFinanceOrAdmin) return null
  if (operatorIds.every((id) => id === profile.id)) return null
  return { ok: false, error: '只能处理本人的运营提成结清' }
}

export async function confirmOperatorCommissionClearance(input: {
  items: Array<{ business_order_id: string; operator_id: string }>
}): Promise<ActionResult> {
  const profile = await requireApproved()
  const parsed = clearanceActionSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }
  const permissionError = await assertCanActOnOperatorClearances(
    parsed.data.items.map((item) => item.operator_id),
    profile,
  )
  if (permissionError) return permissionError

  const supabase = await createClient()
  const now = new Date().toISOString()
  for (const item of parsed.data.items) {
    const { data, error } = await supabase
      .from('finance_business_order_operator_commission_clearances')
      .update({ status: 'confirmed', confirmed_by: profile.id, confirmed_at: now, updated_at: now })
      .eq('business_order_id', item.business_order_id)
      .eq('operator_id', item.operator_id)
      .eq('status', 'pending')
      .select('business_order_id')
    if (error) return { ok: false, error: error.message }
    if ((data?.length ?? 0) === 0) {
      return { ok: false, error: '部分记录不在待确认状态，请刷新页面后重试' }
    }
  }

  revalidateOperatorCommission()
  return { ok: true }
}

export async function rejectOperatorCommissionClearance(input: {
  items: Array<{ business_order_id: string; operator_id: string }>
  reason: string
}): Promise<ActionResult> {
  const profile = await requireApproved()
  const parsed = clearanceRejectSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }
  const permissionError = await assertCanActOnOperatorClearances(
    parsed.data.items.map((item) => item.operator_id),
    profile,
  )
  if (permissionError) return permissionError

  const supabase = await createClient()
  const now = new Date().toISOString()
  for (const item of parsed.data.items) {
    const { data, error } = await supabase
      .from('finance_business_order_operator_commission_clearances')
      .update({
        status: 'rejected',
        rejected_reason: parsed.data.reason,
        rejected_read_at: null,
        updated_at: now,
      })
      .eq('business_order_id', item.business_order_id)
      .eq('operator_id', item.operator_id)
      .eq('status', 'pending')
      .select('business_order_id')
    if (error) return { ok: false, error: error.message }
    if ((data?.length ?? 0) === 0) {
      return { ok: false, error: '部分记录不在待确认状态，请刷新页面后重试' }
    }
  }

  revalidateOperatorCommission()
  return { ok: true }
}

/** 撤回未确认的运营提成结清记录，恢复为待结清；已确认的记录不允许撤回。 */
export async function resetOperatorCommissionClearance(input: {
  items: Array<{ business_order_id: string; operator_id: string }>
}): Promise<ActionResult> {
  await requireFinanceAccess()
  const parsed = clearanceActionSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }
  const supabase = await createClient()
  for (const item of parsed.data.items) {
    const { data, error } = await supabase
      .from('finance_business_order_operator_commission_clearances')
      .delete()
      .eq('business_order_id', item.business_order_id)
      .eq('operator_id', item.operator_id)
      .neq('status', 'confirmed')
      .select('business_order_id')
    if (error) return { ok: false, error: error.message }
    if ((data?.length ?? 0) === 0) {
      return { ok: false, error: '部分记录已结清或不存在，请刷新页面后重试' }
    }
  }

  revalidateOperatorCommission()
  return { ok: true }
}
