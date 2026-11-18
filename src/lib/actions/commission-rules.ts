'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireFinanceAccess } from '@/lib/auth'
import type { ActionResult } from './products'

const rateSchema = z
  .number({ invalid_type_error: '提点必须是数字' })
  .min(0, '提点不能为负')
  .max(100, '提点不能超过 100')
  .refine((value) => value === Math.round(value * 10000) / 10000, '提点最多保留 4 位小数')

const nullableCount = z
  .number({ invalid_type_error: '条件必须是数字' })
  .int('条件必须是整数')
  .nullable()

const ruleSchema = z.object({
  id: z.string().uuid('规则 ID 无效').optional(),
  line: z.enum(['business', 'operator']),
  name: z.string().trim().min(1, '请填写规则名称').max(80, '规则名称最多 80 字'),
  enabled: z.boolean().default(true),
  tag_color: z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, '客户标记颜色应为 #RRGGBB')
    .nullable()
    .default(null),
  shipping_category: z
    .enum(['stock', 'purchase', 'custom', 'sample', 'custom_sample'])
    .nullable()
    .default(null),
  custom_order_count_max: nullableCount.default(null),
  order_index_max: nullableCount.default(null),
  tenure_months_max: nullableCount.default(null),
  product_commission_rate: rateSchema,
})

type RuleInput = z.infer<typeof ruleSchema>

function validateScope(rule: RuleInput): string | null {
  if (rule.custom_order_count_max !== null && rule.custom_order_count_max < 0) {
    return '累计定制订单数不能为负'
  }
  if (rule.order_index_max !== null && rule.order_index_max < 1) {
    return '客户前 N 单至少为 1'
  }
  if (rule.tenure_months_max !== null && rule.tenure_months_max < 0) {
    return '客户年限不能为负'
  }
  if (rule.line === 'operator' && rule.custom_order_count_max !== null) {
    return '运营规则支持客户标记、发货分类、前 N 单和客户年限条件，不支持累计定制订单数'
  }
  return null
}

function revalidateCommissionRules() {
  revalidatePath('/finance/commission')
  revalidatePath('/finance/my-commission')
}

/** 新建规则追加到本线末尾；编辑不动排序，排序只通过 moveCommissionRule 调整。 */
export async function saveCommissionRule(input: RuleInput): Promise<ActionResult> {
  const profile = await requireFinanceAccess()
  const parsed = ruleSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }
  const scopeError = validateScope(parsed.data)
  if (scopeError) return { ok: false, error: scopeError }

  const supabase = await createClient()
  const payload = {
    line: parsed.data.line,
    name: parsed.data.name,
    enabled: parsed.data.enabled,
    tag_color: parsed.data.tag_color ? parsed.data.tag_color.toLowerCase() : null,
    shipping_category: parsed.data.shipping_category,
    custom_order_count_max:
      parsed.data.line === 'business' ? parsed.data.custom_order_count_max : null,
    order_index_max: parsed.data.order_index_max,
    tenure_months_max: parsed.data.tenure_months_max,
    product_commission_rate: parsed.data.product_commission_rate,
  }

  if (parsed.data.id) {
    const { data: existing, error: existingError } = await supabase
      .from('finance_commission_rules')
      .select('id, legacy_source')
      .eq('id', parsed.data.id)
      .eq('line', parsed.data.line)
      .maybeSingle()
    if (existingError) return { ok: false, error: existingError.message }
    if (!existing) return { ok: false, error: '规则不存在或已变更，请刷新后重试' }
    if (existing.legacy_source) {
      return { ok: false, error: '旧设置同步的规则请在对应弹窗中修改，这里只支持调整顺序' }
    }
    const { error } = await supabase
      .from('finance_commission_rules')
      .update(payload)
      .eq('id', parsed.data.id)
      .eq('line', parsed.data.line)
    if (error) return { ok: false, error: error.message }
  } else {
    const { data: last, error: lastError } = await supabase
      .from('finance_commission_rules')
      .select('priority')
      .eq('line', parsed.data.line)
      .order('priority', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (lastError) return { ok: false, error: lastError.message }
    const priority = (last?.priority ?? 0) + 10
    const { error } = await supabase.from('finance_commission_rules').insert({
      ...payload,
      priority,
      created_by: profile.id,
    })
    if (error) return { ok: false, error: error.message }
  }

  revalidateCommissionRules()
  return { ok: true }
}

export async function deleteCommissionRule(input: {
  id: string
  line: 'business' | 'operator'
}): Promise<ActionResult> {
  await requireFinanceAccess()
  const parsed = z
    .object({ id: z.string().uuid(), line: z.enum(['business', 'operator']) })
    .safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('finance_commission_rules')
    .delete()
    .eq('id', parsed.data.id)
    .eq('line', parsed.data.line)
    .is('legacy_source', null)
    .select('id')
  if (error) return { ok: false, error: error.message }
  if ((data?.length ?? 0) === 0) {
    return { ok: false, error: '旧设置同步的规则不能在这里删除，或规则已不存在' }
  }
  revalidateCommissionRules()
  return { ok: true }
}

export async function toggleCommissionRule(input: {
  id: string
  line: 'business' | 'operator'
  enabled: boolean
}): Promise<ActionResult> {
  await requireFinanceAccess()
  const parsed = z
    .object({
      id: z.string().uuid(),
      line: z.enum(['business', 'operator']),
      enabled: z.boolean(),
    })
    .safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('finance_commission_rules')
    .update({ enabled: parsed.data.enabled })
    .eq('id', parsed.data.id)
    .eq('line', parsed.data.line)
    .select('id')
  if (error) return { ok: false, error: error.message }
  if ((data?.length ?? 0) === 0) return { ok: false, error: '规则不存在，请刷新后重试' }
  revalidateCommissionRules()
  return { ok: true }
}

/**
 * 上下移动：整条线重新编号（10,20,30…），同时消除旧播种规则的同优先级并列。
 */
export async function moveCommissionRule(input: {
  id: string
  line: 'business' | 'operator'
  direction: 'up' | 'down'
}): Promise<ActionResult> {
  await requireFinanceAccess()
  const parsed = z
    .object({
      id: z.string().uuid(),
      line: z.enum(['business', 'operator']),
      direction: z.enum(['up', 'down']),
    })
    .safeParse(input)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('finance_commission_rules')
    .select('id, priority, created_at')
    .eq('line', parsed.data.line)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (error) return { ok: false, error: error.message }

  const rows = (data ?? []) as Array<{ id: string; priority: number }>
  const index = rows.findIndex((row) => row.id === parsed.data.id)
  if (index < 0) return { ok: false, error: '规则不存在，请刷新后重试' }
  const target = parsed.data.direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= rows.length) return { ok: true }

  const reordered = [...rows]
  ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]

  for (let position = 0; position < reordered.length; position += 1) {
    const nextPriority = (position + 1) * 10
    if (reordered[position].priority === nextPriority) continue
    const { error: updateError } = await supabase
      .from('finance_commission_rules')
      .update({ priority: nextPriority })
      .eq('id', reordered[position].id)
    if (updateError) return { ok: false, error: updateError.message }
  }

  revalidateCommissionRules()
  return { ok: true }
}
