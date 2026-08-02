import { requireProfile } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import {
  ProductGroupManager,
  type ProductGroupWithCount,
} from '@/components/products/product-group-manager'
import type { ProductGroup } from '@/types'

export default async function ProductGroupsPage() {
  await requireProfile()
  const supabase = await createClient()

  const [{ data: groupData }, { data: productData }] = await Promise.all([
    supabase.from('product_groups').select('*').order('sort_order'),
    supabase.from('products').select('group_id'),
  ])

  const groups = (groupData ?? []) as ProductGroup[]
  const counts = new Map<string, number>()
  ;(productData ?? []).forEach((row: { group_id: string | null }) => {
    if (row.group_id) counts.set(row.group_id, (counts.get(row.group_id) ?? 0) + 1)
  })

  const withCounts: ProductGroupWithCount[] = groups.map((g) => ({
    ...g,
    product_count: counts.get(g.id) ?? 0,
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">产品分组</h1>
        <p className="text-sm text-muted-foreground">对产品进行自定义分组，便于筛选与管理。</p>
      </div>
      <ProductGroupManager groups={withCounts} />
    </div>
  )
}
