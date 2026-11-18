import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  BusinessOrderCommissionRow,
  BusinessOrderOperatorAssignment,
  BusinessOrderOperatorCommissionClearance,
  OperatorCommissionRow,
  OperatorCommissionSummaryTotal,
  ShopOperatorRule,
} from '@/types'
import type { BusinessOrderCommissionFilters } from '@/lib/business-order-commission'
import { fetchEligibleCommissionRows } from '@/lib/business-order-commissions-server'
import { matchCommissionRule, type CommissionRuleContext } from '@/lib/commission-rules'
import { fetchCommissionOrderContext, fetchCommissionRules } from '@/lib/commission-rules-server'
import {
  OPERATOR_COMMISSION_PAGE_SIZE,
  calculateOperatorCommission,
  resolveOrderOperators,
  summarizeOperatorCommission,
  type OperatorRuleInput,
} from '@/lib/operator-commission'
import { displayProfileName } from '@/lib/utils'

const CHUNK_SIZE = 100

function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = []
  for (let index = 0; index < ids.length; index += CHUNK_SIZE) {
    chunks.push(ids.slice(index, index + CHUNK_SIZE))
  }
  return chunks
}

function round4(value: number) {
  return Math.round(value * 10000) / 10000
}

export interface OperatorCandidate {
  id: string
  name: string
  role: string
}

export interface ShopOperatorRuleWithName extends ShopOperatorRule {
  operator_name: string
}

export interface OrderOperatorAssignmentWithName extends BusinessOrderOperatorAssignment {
  operator_name: string
}

interface OperatorProfileRow {
  id: string
  role: string
  chinese_name: string | null
  full_name: string | null
  email: string | null
}

async function fetchProfilesByIds(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, OperatorProfileRow>> {
  const profiles: OperatorProfileRow[] = []
  for (const chunk of chunkIds([...new Set(ids)])) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, role, chinese_name, full_name, email')
      .in('id', chunk)
    if (error) throw new Error(`运营人员读取失败：${error.message}`)
    profiles.push(...((data ?? []) as OperatorProfileRow[]))
  }
  return new Map(profiles.map((profile) => [profile.id, profile]))
}

/** 可作为运营提成归属人的账号：运营角色 + 管理员（管理员也可参与运营提成）。 */
export async function fetchOperatorCandidates(
  supabase: SupabaseClient,
): Promise<OperatorCandidate[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, role, chinese_name, full_name, email')
    .in('role', ['operations', 'admin'])
    .eq('status', 'approved')
    .order('full_name')
  if (error) throw new Error(`运营人员读取失败：${error.message}`)
  return ((data ?? []) as OperatorProfileRow[]).map((profile) => ({
    id: profile.id,
    name: displayProfileName(profile),
    role: profile.role,
  }))
}

interface OrderMeta {
  shop_id: string | null
  shop_name: string | null
  exchange_rate_to_cny: number | null
}

async function fetchOrderMeta(
  supabase: SupabaseClient,
  orderIds: string[],
): Promise<Map<string, OrderMeta>> {
  const meta = new Map<string, OrderMeta>()
  for (const chunk of chunkIds(orderIds)) {
    const { data, error } = await supabase
      .from('business_orders')
      .select('id, shop_id, shop_name_snapshot, exchange_rate_to_cny')
      .in('id', chunk)
    if (error) throw new Error(`运营提成订单读取失败：${error.message}`)
    for (const row of (data ?? []) as Array<{
      id: string
      shop_id: string | null
      shop_name_snapshot: string | null
      exchange_rate_to_cny: number | null
    }>) {
      meta.set(row.id, {
        shop_id: row.shop_id,
        shop_name: row.shop_name_snapshot,
        exchange_rate_to_cny: row.exchange_rate_to_cny == null ? null : Number(row.exchange_rate_to_cny),
      })
    }
  }
  return meta
}

async function fetchAssignmentsForOrders(
  supabase: SupabaseClient,
  orderIds: string[],
): Promise<BusinessOrderOperatorAssignment[]> {
  const rows: BusinessOrderOperatorAssignment[] = []
  for (const chunk of chunkIds(orderIds)) {
    const { data, error } = await supabase
      .from('finance_business_order_operator_assignments')
      .select('*')
      .in('business_order_id', chunk)
    if (error) throw new Error(`订单运营指定读取失败：${error.message}`)
    rows.push(...((data ?? []) as BusinessOrderOperatorAssignment[]))
  }
  return rows
}

async function fetchShopRulesForShops(
  supabase: SupabaseClient,
  shopIds: string[],
): Promise<ShopOperatorRule[]> {
  const rows: ShopOperatorRule[] = []
  for (const chunk of chunkIds([...new Set(shopIds)])) {
    const { data, error } = await supabase
      .from('finance_shop_operator_rules')
      .select('*')
      .in('shop_id', chunk)
    if (error) throw new Error(`店铺运营规则读取失败：${error.message}`)
    rows.push(...((data ?? []) as ShopOperatorRule[]))
  }
  return rows
}

async function fetchOperatorClearances(
  supabase: SupabaseClient,
  orderIds: string[],
): Promise<BusinessOrderOperatorCommissionClearance[]> {
  const rows: BusinessOrderOperatorCommissionClearance[] = []
  for (const chunk of chunkIds(orderIds)) {
    const { data, error } = await supabase
      .from('finance_business_order_operator_commission_clearances')
      .select('*')
      .in('business_order_id', chunk)
    if (error) throw new Error(`运营提成结清记录读取失败：${error.message}`)
    rows.push(...((data ?? []) as BusinessOrderOperatorCommissionClearance[]))
  }
  return rows
}

function toRuleInput(row: {
  operator_id: string
  share_percent: number
  product_commission_rate: number
  rate_mode?: string | null
}): OperatorRuleInput {
  return {
    operator_id: row.operator_id,
    share_percent: Number(row.share_percent),
    product_commission_rate: Number(row.product_commission_rate),
    rate_mode: row.rate_mode === 'rules' ? 'rules' : 'fixed',
  }
}

export interface OperatorCommissionResult {
  rows: OperatorCommissionRow[]
  totalCount: number
  summary?: OperatorCommissionSummaryTotal[]
}

/**
 * 运营提成一行 = 订单 × 运营人。
 * 产品实收沿用业务提成的产品行口径（已收齐且已发货的产品行合计）；
 * 归属先看订单级指定（指定即替代），否则用订单所属店铺的运营规则。
 */
export async function fetchOperatorCommission(
  supabase: SupabaseClient,
  filters: BusinessOrderCommissionFilters,
  options: {
    operatorId?: string | null
    scope?: 'pending' | 'settled'
    /** 仅返回待本人确认的记录（运营「我的提成」待确认区）。 */
    pendingOnly?: boolean
    includeSummary?: boolean
  } = {},
): Promise<OperatorCommissionResult> {
  const scope = options.scope ?? 'pending'
  const commissionRows = await fetchEligibleCommissionRows(supabase, filters)
  if (commissionRows.length === 0) {
    return { rows: [], totalCount: 0, summary: options.includeSummary ? [] : undefined }
  }

  const orderIds = [...new Set(commissionRows.map((row) => row.order_id))]
  const [orderMeta, operatorRules, orderContext] = await Promise.all([
    fetchOrderMeta(supabase, orderIds),
    fetchCommissionRules(supabase, 'operator'),
    fetchCommissionOrderContext(supabase, orderIds),
  ])
  const shopIds = [...orderMeta.values()]
    .map((meta) => meta.shop_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  const [assignments, shopRules, clearances] = await Promise.all([
    fetchAssignmentsForOrders(supabase, orderIds),
    fetchShopRulesForShops(supabase, shopIds),
    fetchOperatorClearances(supabase, orderIds),
  ])

  const profileIds = [
    ...assignments.map((row) => row.operator_id),
    ...shopRules.map((row) => row.operator_id),
    ...clearances.map((row) => row.operator_id),
  ]
  const profiles = await fetchProfilesByIds(supabase, profileIds)
  const nameOf = (id: string) => displayProfileName(profiles.get(id) ?? null)

  const assignmentMap = new Map<string, OperatorRuleInput[]>()
  for (const row of assignments) {
    const list = assignmentMap.get(row.business_order_id) ?? []
    list.push(toRuleInput(row))
    assignmentMap.set(row.business_order_id, list)
  }
  const shopRuleMap = new Map<string, OperatorRuleInput[]>()
  for (const row of shopRules) {
    const list = shopRuleMap.get(row.shop_id) ?? []
    list.push(toRuleInput(row))
    shopRuleMap.set(row.shop_id, list)
  }
  const clearanceMap = new Map<string, BusinessOrderOperatorCommissionClearance>()
  for (const row of clearances) {
    clearanceMap.set(`${row.business_order_id}\u0000${row.operator_id}`, row)
  }

  interface OrderAggregate {
    order_number: string
    order_date: string
    shop_name: string | null
    customer_name: string | null
    salesperson_name: string
    currency: BusinessOrderCommissionRow['currency']
    product_received_amount: number
  }
  const orderAggregate = new Map<string, OrderAggregate>()
  const orderTagColor = new Map<string, string | null>()
  const orderCategories = new Map<string, Set<string>>()
  for (const row of commissionRows) {
    const aggregate = orderAggregate.get(row.order_id) ?? {
      order_number: row.order_number,
      order_date: row.order_date,
      shop_name: orderMeta.get(row.order_id)?.shop_name ?? row.shop_name,
      customer_name: row.customer_name,
      salesperson_name: row.salesperson_name,
      currency: row.currency,
      product_received_amount: 0,
    }
    aggregate.product_received_amount = round4(
      aggregate.product_received_amount + Number(row.product_received_amount),
    )
    orderAggregate.set(row.order_id, aggregate)
    orderTagColor.set(row.order_id, row.customer_tag_color)
    if (row.shipping_category) {
      const categories = orderCategories.get(row.order_id) ?? new Set<string>()
      categories.add(row.shipping_category)
      orderCategories.set(row.order_id, categories)
    }
  }

  const built: OperatorCommissionRow[] = []
  for (const [orderId, aggregate] of orderAggregate) {
    const meta = orderMeta.get(orderId)
    const shopId = meta?.shop_id ?? null
    const resolved = resolveOrderOperators(
      shopId,
      assignmentMap.get(orderId) ?? [],
      shopId ? shopRuleMap.get(shopId) ?? [] : [],
    )
    for (const operator of resolved) {
      const clearance = clearanceMap.get(`${orderId}\u0000${operator.operator_id}`)
      const window = orderContext.get(orderId)
      const tagColor = orderTagColor.get(orderId) ?? null
      const categories = orderCategories.get(orderId)
      const ruleContext: CommissionRuleContext = {
        tagColor: tagColor ? tagColor.toLowerCase() : null,
        shippingCategory: categories && categories.size > 0 ? [...categories] : null,
        customOrderCount: null,
        orderIndex: window?.orderIndex ?? null,
        tenureMonths: window?.tenureMonths ?? null,
      }
      const matchedRule = operator.rate_mode === 'rules'
        ? matchCommissionRule(operatorRules, ruleContext)
        : null
      const effectiveRate = operator.rate_mode === 'rules'
        ? matchedRule?.rate ?? 0
        : operator.product_commission_rate
      built.push({
        order_id: orderId,
        order_number: aggregate.order_number,
        order_date: aggregate.order_date,
        shop_id: shopId,
        shop_name: aggregate.shop_name,
        customer_name: aggregate.customer_name,
        salesperson_name: aggregate.salesperson_name,
        operator_id: operator.operator_id,
        operator_name: nameOf(operator.operator_id),
        share_percent: operator.share_percent,
        product_commission_rate: effectiveRate,
        rate_mode: operator.rate_mode,
        commission_rule_name: matchedRule ? matchedRule.rule.name : null,
        product_received_amount: aggregate.product_received_amount,
        commission_amount: calculateOperatorCommission(
          aggregate.product_received_amount,
          effectiveRate,
          operator.share_percent,
        ),
        currency: aggregate.currency,
        settlement_exchange_rate_to_cny:
          clearance?.settlement_exchange_rate_to_cny ?? meta?.exchange_rate_to_cny ?? null,
        clearance_status: clearance?.status ?? null,
        clearance_period: clearance ? String(clearance.period).slice(0, 7) : null,
        has_assignment: operator.has_assignment,
      })
    }
  }

  const scoped = built.filter((row) =>
    scope === 'settled'
      ? row.clearance_status === 'confirmed'
      : options.pendingOnly
        ? row.clearance_status === 'pending'
        : row.clearance_status !== 'confirmed',
  )
  const filtered = options.operatorId
    ? scoped.filter((row) => row.operator_id === options.operatorId)
    : scoped

  const page = Math.max(1, filters.page)
  const offset = (page - 1) * OPERATOR_COMMISSION_PAGE_SIZE
  return {
    rows: filtered.slice(offset, offset + OPERATOR_COMMISSION_PAGE_SIZE),
    totalCount: filtered.length,
    summary: options.includeSummary ? summarizeOperatorCommission(filtered) : undefined,
  }
}

/** 店铺运营规则（含运营姓名），供规则设置弹窗展示。 */
export async function fetchShopOperatorRules(
  supabase: SupabaseClient,
): Promise<ShopOperatorRuleWithName[]> {
  const { data, error } = await supabase
    .from('finance_shop_operator_rules')
    .select('*')
    .order('created_at')
  if (error) throw new Error(`店铺运营规则读取失败：${error.message}`)
  const rules = (data ?? []) as ShopOperatorRule[]
  const profiles = await fetchProfilesByIds(supabase, rules.map((rule) => rule.operator_id))
  return rules.map((rule) => ({
    ...rule,
    operator_name: displayProfileName(profiles.get(rule.operator_id) ?? null),
  }))
}

/** 某订单当前的运营指定（含运营姓名），供订单指定弹窗回填。 */
export async function fetchOrderOperatorAssignments(
  supabase: SupabaseClient,
  orderId: string,
): Promise<OrderOperatorAssignmentWithName[]> {
  const { data, error } = await supabase
    .from('finance_business_order_operator_assignments')
    .select('*')
    .eq('business_order_id', orderId)
  if (error) throw new Error(`订单运营指定读取失败：${error.message}`)
  const assignments = (data ?? []) as BusinessOrderOperatorAssignment[]
  const profiles = await fetchProfilesByIds(supabase, assignments.map((row) => row.operator_id))
  return assignments.map((row) => ({
    ...row,
    operator_name: displayProfileName(profiles.get(row.operator_id) ?? null),
  }))
}

/** 运营侧待确认角标：本人处于待确认状态的结清记录数。 */
export async function fetchOperatorCommissionAttentionCount(
  supabase: SupabaseClient,
  operatorId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('finance_business_order_operator_commission_clearances')
    .select('business_order_id', { count: 'exact', head: true })
    .eq('operator_id', operatorId)
    .eq('status', 'pending')
  if (error) throw new Error(`运营提成待确认读取失败：${error.message}`)
  return count ?? 0
}
