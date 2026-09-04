import Link from 'next/link'
import { Plus } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getCurrentProfile } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { ProductFilters } from '@/components/products/product-filters'
import { ProductTable } from '@/components/products/product-table'
import type { Product, ProductFinancial, ProductGroup } from '@/types'

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string; group?: string }>
}) {
  const { q, category, group } = await searchParams
  const profile = await getCurrentProfile()
  const isAdmin = profile?.role === 'admin'
  const canManageFinancials =
    profile?.status === 'approved' && (profile.role === 'admin' || profile.role === 'finance')
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

  let financials: ProductFinancial[] = []
  if (canManageFinancials && products.length > 0) {
    // 不要按 product_id 逐个 .in() 过滤：商品数量较多时会拼出超长 GET URL，
    // 被网关以 HTTP 414 (URI too long) 拒绝。product_financials 已由 RLS 限定
    // 仅财务/管理员可见，且每个产品至多一行，直接全量拉取后在内存中按当前展示的产品过滤。
    const productIds = new Set(products.map((product) => product.id))
    const { data: financialData, error: financialError } = await supabase
      .from('product_financials')
      .select('*')
    if (financialError) throw new Error('加载产品财务资料失败')
    financials = ((financialData ?? []) as ProductFinancial[]).filter((item) =>
      productIds.has(item.product_id),
    )
  }

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

      <ProductTable
        products={products}
        groups={groups}
        financials={financials}
        canManage={true}
        canDelete={isAdmin}
        canManageFinancials={canManageFinancials}
      />
    </div>
  )
}
