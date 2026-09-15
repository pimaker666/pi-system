import type { SupabaseClient } from '@supabase/supabase-js'
import type { BusinessOrderItem } from '@/types'

export interface ProductFinancialLabel {
  financial_number: string | null
  product_name: string | null
}

/**
 * 普通产品在订单里的展示名/编码：财务在产品库维护了「产品名称」时，
 * 名称优先用产品名称、编码换成财务编号（未维护编号时回落 SKU）；
 * 没维护产品名称则整套用下单快照（销售名称 + SKU）。定制产品始终用快照。
 * 展示字段由服务端装载时附加到条目上；product_financials 的 RLS 只放行
 * 财务/管理员，销售读到空表自然回落快照，不改变数据可见性。
 */
export interface BusinessOrderItemDisplayFields {
  display_name?: string | null
  display_sku?: string | null
}

export type BusinessOrderItemWithDisplay = BusinessOrderItem & BusinessOrderItemDisplayFields

/** 全量读取产品财务标签；表与产品库同级大小，且 RLS 已按角色过滤。 */
export async function fetchProductFinancialLabels(
  supabase: SupabaseClient,
): Promise<Map<string, ProductFinancialLabel>> {
  const { data, error } = await supabase
    .from('product_financials')
    .select('product_id, financial_number, product_name')
  if (error) throw new Error(`产品财务信息读取失败：${error.message}`)
  return new Map(
    ((data ?? []) as Array<ProductFinancialLabel & { product_id: string }>).map((row) => [
      row.product_id,
      { financial_number: row.financial_number, product_name: row.product_name },
    ]),
  )
}

export function applyBusinessOrderItemDisplay<T extends BusinessOrderItem>(
  item: T,
  labels: Map<string, ProductFinancialLabel>,
): T & BusinessOrderItemDisplayFields {
  if (item.source_type === 'custom' || !item.product_id) return item
  const label = labels.get(item.product_id)
  // 产品名称未维护时整套回落销售快照，避免名称与编号只换一半对不上。
  if (!label?.product_name) return item
  return {
    ...item,
    display_name: label.product_name,
    display_sku: label.financial_number || item.sku_snapshot,
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
