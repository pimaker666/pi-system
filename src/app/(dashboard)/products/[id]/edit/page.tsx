import { notFound } from 'next/navigation'
import { requireProfile } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { ProductForm } from '@/components/products/product-form'
import { KNOWN_CATEGORIES } from '@/schemas/product'
import type { Product, ProductGroup } from '@/types'

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireProfile()
  const { id } = await params
  const supabase = await createClient()

  const [{ data }, { data: groupData }, { data: catData }] = await Promise.all([
    supabase.from('products').select('*').eq('id', id).single(),
    supabase.from('product_groups').select('*').order('sort_order'),
    supabase.from('products').select('category'),
  ])
  if (!data) notFound()

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
      <h1 className="text-2xl font-semibold">编辑产品</h1>
      <ProductForm product={data as Product} groups={groups} categories={categories} />
    </div>
  )
}
