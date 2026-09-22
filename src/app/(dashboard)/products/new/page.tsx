import { requireProfile } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { ProductForm } from '@/components/products/product-form'
import type { ProductGroup } from '@/types'

export default async function NewProductPage() {
  await requireProfile()
  const supabase = await createClient()

  const { data: groupData } = await supabase
    .from('product_groups')
    .select('*')
    .order('sort_order')

  const groups = (groupData ?? []) as ProductGroup[]

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">新增产品</h1>
      <ProductForm groups={groups} />
    </div>
  )
}
