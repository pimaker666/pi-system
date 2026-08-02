import Link from 'next/link'
import { Plus } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getCurrentProfile } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { ProductFilters } from '@/components/products/product-filters'
import { ProductTable } from '@/components/products/product-table'
import type { Product, ProductGroup } from '@/types'

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string; group?: string }>
}) {
  const { q, category, group } = await searchParams
  const profile = await getCurrentProfile()
  const isAdmin = profile?.role === 'admin'
  const supabase = await createClient()

  let query = supabase.from('products').select('*').order('created_at', { ascending: false })
  if (q?.trim()) {
    const term = q.trim()
    query = query.or(`sku.ilike.%${term}%,name.ilike.%${term}%`)
  }
  if (category) query = query.eq('category', category)
  if (group === '__none__') query = query.is('group_id', null)
  else if (group) query = query.eq('group_id', group)

  const [{ data }, { data: groupData }, { data: catData }] = await Promise.all([
    query,
    supabase.from('product_groups').select('*').order('sort_order'),
    supabase.from('products').select('category'),
  ])

  const products = (data ?? []) as Product[]
  const groups = (groupData ?? []) as ProductGroup[]
  const categories = Array.from(
    new Set(
      (catData ?? [])
        .map((r: { category: string | null }) => r.category)
        .filter(Boolean) as string[],
    ),
  ).sort()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">产品库</h1>
        <Button asChild>
          <Link href="/products/new">
            <Plus className="h-4 w-4" />
            新增产品
          </Link>
        </Button>
      </div>

      <ProductFilters
        categories={categories}
        groups={groups}
        q={q ?? ''}
        category={category ?? ''}
        group={group ?? ''}
      />

      <ProductTable products={products} groups={groups} canManage={true} canDelete={isAdmin} />
    </div>
  )
}
