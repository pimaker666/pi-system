import { notFound } from 'next/navigation'
import { requireProfile } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { ProductForm } from '@/components/products/product-form'
import type { Product, ProductGroup } from '@/types'

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireProfile()
  const { id } = await params
  const supabase = await createClient()

  const [{ data }, { data: groupData }] = await Promise.all([
    supabase.from('products').select('*').eq('id', id).single(),
    supabase.from('product_groups').select('*').order('sort_order'),
  ])
  if (!data) notFound()

  const groups = (groupData ?? []) as ProductGroup[]

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">编辑产品</h1>
      <ProductForm product={data as Product} groups={groups} />
    </div>
  )
}
