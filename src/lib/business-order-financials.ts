import type { SupabaseClient } from '@supabase/supabase-js'
import type { BusinessOrderItem, BusinessOrderItemSourceType } from '@/types'

export interface ProductFinancialLabel {
  financial_number: string | null
  product_name: string | null
}

/**
 * 普通产品在订单里的展示名/编码：财务在产品库维护了「产品名称」时，
 * 名称优先用产品名称、编码换成财务编号（未维护编号时回落 SKU）；
 * 没维护产品名称则整套用下单快照（销售名称 + SKU）。定制产品始终用快照。
 * 名称与财务编号对所有角色可见（读取 product_financial_labels 视图），
 * 成本等其余财务字段仍只对财务/管理员开放。
 */
export interface BusinessOrderItemDisplayFields {
  display_name?: string | null
  display_sku?: string | null
}

export type BusinessOrderItemWithDisplay = BusinessOrderItem & BusinessOrderItemDisplayFields

/** 全量读取产品展示字段；视图已向所有登录角色开放名称与财务编号。 */
export async function queryProductFinancialLabels(
  supabase: SupabaseClient,
): Promise<Array<ProductFinancialLabel & { product_id: string }>> {
  const { data, error } = await supabase
    .from('product_financial_labels')
    .select('product_id, financial_number, product_name')
  if (error) throw new Error(`产品财务信息读取失败：${error.message}`)
  return (data ?? []) as Array<ProductFinancialLabel & { product_id: string }>
}

export function productFinancialLabelMap(
  rows: Array<ProductFinancialLabel & { product_id: string }>,
): Map<string, ProductFinancialLabel> {
  return new Map(
    rows.map((row) => [
      row.product_id,
      { financial_number: row.financial_number, product_name: row.product_name },
    ]),
  )
}

/** 全量读取产品财务标签；表与产品库同级大小，且 RLS 已按角色过滤。 */
export async function fetchProductFinancialLabels(
  supabase: SupabaseClient,
): Promise<Map<string, ProductFinancialLabel>> {
  return productFinancialLabelMap(await queryProductFinancialLabels(supabase))
}

export interface ResolvedProductDisplay {
  name: string
  sku: string | null
}

/**
 * 普通产品展示名/编码的统一口径：维护了财务产品名称时名称与编码整套切换，
 * 否则返回 null 由调用方沿用下单快照；定制产品（或未关联产品库）始终用快照。
 */
export function resolveProductDisplay(
  sourceType: BusinessOrderItemSourceType,
  productId: string | null,
  snapshot: { sku: string | null },
  labels: Map<string, ProductFinancialLabel>,
): ResolvedProductDisplay | null {
  if (sourceType === 'custom' || !productId) return null
  const label = labels.get(productId)
  // 产品名称未维护时整套回落销售快照，避免名称与编号只换一半对不上。
  if (!label?.product_name) return null
  return {
    name: label.product_name,
    sku: label.financial_number || snapshot.sku,
  }
}

export function applyBusinessOrderItemDisplay<T extends BusinessOrderItem>(
  item: T,
  labels: Map<string, ProductFinancialLabel>,
): T & BusinessOrderItemDisplayFields {
  const display = resolveProductDisplay(
    item.source_type,
    item.product_id,
    { sku: item.sku_snapshot },
    labels,
  )
  if (!display) return item
  return {
    ...item,
    display_name: display.name,
    display_sku: display.sku,
  }
}

export async function attachBusinessOrderItemsDisplay(
  supabase: SupabaseClient,
  items: BusinessOrderItem[],
): Promise<BusinessOrderItemWithDisplay[]> {
  const hasLinkedProducts = items.some(
    (item) => item.source_type !== 'custom' && item.product_id,
  )
  if (!hasLinkedProducts) return items
  const labels = await fetchProductFinancialLabels(supabase)
  return items.map((item) => applyBusinessOrderItemDisplay(item, labels))
}

export function businessOrderItemDisplayName(
  item: { name_snapshot: string } & BusinessOrderItemDisplayFields,
): string {
  return item.display_name ?? item.name_snapshot
}

export function businessOrderItemDisplaySku(
  item: { sku_snapshot: string } & BusinessOrderItemDisplayFields,
): string {
  return item.display_sku ?? item.sku_snapshot
}
