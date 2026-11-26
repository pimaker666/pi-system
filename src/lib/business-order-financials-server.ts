import { unstable_cache } from 'next/cache'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BusinessOrderItem } from '@/types'
import {
  applyBusinessOrderItemDisplay,
  productFinancialLabelMap,
  queryProductFinancialLabels,
  type BusinessOrderItemWithDisplay,
  type ProductFinancialLabel,
} from '@/lib/business-order-financials'

const PRODUCT_FINANCIAL_LABELS_TTL_SECONDS = 120

/**
 * 产品名称/财务编号对所有角色开放（product_financial_labels 视图），
 * 同一份全量标签可以跨请求缓存；成本等敏感字段仍走财务 RLS，不在此处读取。
 */
export async function fetchProductFinancialLabelsCached(
  supabase: SupabaseClient,
): Promise<Map<string, ProductFinancialLabel>> {
  const rows = await unstable_cache(
    () => queryProductFinancialLabels(supabase),
    ['product-financial-labels', 'shared'],
    { revalidate: PRODUCT_FINANCIAL_LABELS_TTL_SECONDS },
  )()
  return productFinancialLabelMap(rows)
}

export async function attachBusinessOrderItemsDisplayCached(
  supabase: SupabaseClient,
  items: BusinessOrderItem[],
): Promise<BusinessOrderItemWithDisplay[]> {
  const hasLinkedProducts = items.some(
    (item) => item.source_type !== 'custom' && item.product_id,
  )
  if (!hasLinkedProducts) return items
  const labels = await fetchProductFinancialLabelsCached(supabase)
  return items.map((item) => applyBusinessOrderItemDisplay(item, labels))
}
