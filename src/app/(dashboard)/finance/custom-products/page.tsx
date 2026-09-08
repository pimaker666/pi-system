import { redirect } from 'next/navigation'
import { BusinessCustomProductLibrary } from '@/components/finance/business-custom-product-library'
import { listBusinessCustomProductsLibrary } from '@/lib/actions/business-orders'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import type { Customer } from '@/types'

export default async function BusinessCustomProductsPage() {
  const profile = await requireApproved()
  if (!['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)) {
    redirect('/dashboard')
  }

  const supabase = await createClient()
  const [productsResult, customersResult] = await Promise.all([
    listBusinessCustomProductsLibrary({ status: 'all' }),
    supabase.from('customers').select('*').order('name'),
  ])

  if (customersResult.error) {
    throw new Error(`客户读取失败：${customersResult.error.message}`)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">定制产品库</h1>
        <p className="text-sm text-muted-foreground">
          维护客户专属产品及不可变版本；历史订单始终保留其下单时引用的版本。
        </p>
      </div>
      <BusinessCustomProductLibrary
        initialProducts={productsResult.data ?? []}
        customers={(customersResult.data ?? []) as Customer[]}
        profileId={profile.id}
        profileRole={profile.role}
        initialError={productsResult.ok ? null : productsResult.error}
      />
    </div>
  )
}
