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
 * product_financials 的 RLS 只放行财务/管理员，且同组内可见行完全一致，
 * 因此 privileged 组共享一份跨请求缓存；其他角色直接空表，与原 RLS
 * 查询结果一致但省一次查询。非 privileged 结果绝不入缓存键共享。
 */
export async function fetchProductFinancialLabelsCached(
  supabase: SupabaseClient,
  viewerRole: string,
): Promise<Map<string, ProductFinancialLabel>> {
  if (viewerRole !== 'admin' && viewerRole !== 'finance') return new Map()
  const rows = await unstable_cache(
    () => queryProductFinancialLabels(supabase),
    ['product-financial-labels', 'privileged'],
    { revalidate: PRODUCT_FINANCIAL_LABELS_TTL_SECONDS },
  )()
  return productFinancialLabelMap(rows)
}

export async function attachBusinessOrderItemsDisplayCached(
  supabase: SupabaseClient,
  items: BusinessOrderItem[],
  viewerRole: string,
): Promise<BusinessOrderItemWithDisplay[]> {
  const hasLinkedProducts = items.some(
    (item) => item.source_type !== 'custom' && item.product_id,
  )
  if (!hasLinkedProducts) return items
  const labels = await fetchProductFinancialLabelsCached(supabase, viewerRole)
  return items.map((item) => applyBusinessOrderItemDisplay(item, labels))
}
