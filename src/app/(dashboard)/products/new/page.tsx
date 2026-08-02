import { requireProfile } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { ProductForm } from '@/components/products/product-form'
import { KNOWN_CATEGORIES } from '@/schemas/product'
import type { ProductGroup } from '@/types'

export default async function NewProductPage() {
  await requireProfile()
  const supabase = await createClient()

  const [{ data: groupData }, { data: catData }] = await Promise.all([
    supabase.from('product_groups').select('*').order('sort_order'),
    supabase.from('products').select('category'),
  ])

  const groups = (groupData ?? []) as ProductGroup[]
  const categories = Array.from(
    new Set([
      ...KNOWN_CATEGORIES,
      ...((catData ?? [])
        .map((r: { category: string | null }) => r.category)
        .filter(Boolean) as string[]),
    ]),
  ).sort()

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">新增产品</h1>
      <ProductForm groups={groups} categories={categories} />
    </div>
  )
}
