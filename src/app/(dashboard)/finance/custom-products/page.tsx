import { redirect } from 'next/navigation'
import { BusinessCustomProductLibrary } from '@/components/finance/business-custom-product-library'
import { listBusinessCustomProductsLibrary } from '@/lib/actions/business-orders'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import type { ProductGroup } from '@/types'

export default async function BusinessCustomProductsPage() {
  const profile = await requireApproved()
  if (!['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)) {
    redirect('/dashboard')
  }

  const supabase = await createClient()
  const [productsResult, groupsResult] = await Promise.all([
    listBusinessCustomProductsLibrary({ status: 'all' }),
    supabase.from('product_groups').select('*').order('sort_order'),
  ])

  if (groupsResult.error) {
    throw new Error(`产品分组读取失败：${groupsResult.error.message}`)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">定制产品库</h1>
        <p className="text-sm text-muted-foreground">
          维护全局定制产品及不可变版本；历史订单始终保留其下单时引用的版本。
        </p>
      </div>
      <BusinessCustomProductLibrary
        initialProducts={productsResult.data ?? []}
        productGroups={(groupsResult.data ?? []) as ProductGroup[]}
        profileRole={profile.role}
        initialError={productsResult.ok ? null : productsResult.error}
      />
    </div>
  )
}
