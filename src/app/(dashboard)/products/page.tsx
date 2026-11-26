import Link from 'next/link'
import { Plus } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getCurrentProfile, hasCurrentPermission } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { ProductFilters } from '@/components/products/product-filters'
import { ProductTable } from '@/components/products/product-table'
import type { Product, ProductFinancial, ProductFinancialLabelView, ProductGroup } from '@/types'

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; group?: string; financialNumber?: string }>
}) {
  const { q, group, financialNumber } = await searchParams
  const term = q?.trim() ?? ''
  const financialNumberFilter = financialNumber === 'has' || financialNumber === 'missing'
    ? financialNumber
    : ''
  const profile = await getCurrentProfile()
  const canManageFinancials =
    profile?.status === 'approved' && (profile.role === 'admin' || profile.role === 'finance')
  const supabase = await createClient()

  let query = supabase.from('products').select('*').order('created_at', { ascending: false })
  if (group === '__none__') query = query.is('group_id', null)
  else if (group) query = query.eq('group_id', group)

  // 财务编号与产品名称对所有角色只读可见（product_financial_labels 视图）；
  // 含成本在内的完整财务资料仍只向财务/管理员读取，编辑入口也只对他们开放。
  const [{ data }, { data: groupData }, labelsResult, financialResult, canDeleteProducts] =
    await Promise.all([
      query,
      supabase.from('product_groups').select('*').order('sort_order'),
      supabase.from('product_financial_labels').select('product_id, financial_number, product_name'),
      canManageFinancials
        ? supabase.from('product_financials').select('*')
        : Promise.resolve({ data: [] as ProductFinancial[], error: null }),
      profile?.status === 'approved' ? hasCurrentPermission('products.delete') : Promise.resolve(false),
    ])

  if (labelsResult.error) throw new Error('加载产品财务标签失败')

  let products = (data ?? []) as Product[]
  const groups = (groupData ?? []) as ProductGroup[]
  const financialLabels = (labelsResult.data ?? []) as ProductFinancialLabelView[]
  const labelByProductId = new Map(financialLabels.map((label) => [label.product_id, label]))

  let financials: ProductFinancial[] = []
  if (canManageFinancials) {
    if (financialResult.error) throw new Error('加载产品财务资料失败')
    financials = (financialResult.data ?? []) as ProductFinancial[]
  }

  // 财务标签随列表全量拉取，关键字与“有无财务编号”的筛选统一在内存里做。
  if (term) {
    const keyword = term.toLocaleLowerCase()
    products = products.filter((product) => {
      const label = labelByProductId.get(product.id)
      return [product.sku, product.name, label?.financial_number, label?.product_name].some(
        (value) => value?.toLocaleLowerCase().includes(keyword),
      )
    })
  }
  if (financialNumberFilter) {
    products = products.filter((product) => {
      const hasFinancialNumber = Boolean(labelByProductId.get(product.id)?.financial_number?.trim())
      return financialNumberFilter === 'has' ? hasFinancialNumber : !hasFinancialNumber
    })
  }

  if (canManageFinancials) {
    const productIds = new Set(products.map((product) => product.id))
    financials = financials.filter((item) => productIds.has(item.product_id))
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
        groups={groups}
        q={q ?? ''}
        group={group ?? ''}
        financialNumber={financialNumberFilter}
      />

      <ProductTable
        products={products}
        groups={groups}
        financials={financials}
        financialLabels={financialLabels}
        canManage={true}
        canDelete={canDeleteProducts}
        canManageStatus={canManageFinancials}
        canManageFinancials={canManageFinancials}
      />
    </div>
  )
}
