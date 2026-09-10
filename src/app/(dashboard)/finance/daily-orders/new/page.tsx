import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { BusinessOrderForm } from '@/components/finance/business-order-form'
import { Button } from '@/components/ui/button'
import { requireApproved } from '@/lib/auth'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'
import type { Customer, CustomerGroup, Product, ProductGroup } from '@/types'

export default async function NewBusinessOrderPage() {
  const profile = await requireApproved()
  if (!['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)) {
    redirect('/finance/daily-orders')
  }

  const supabase = await createClient()
  const customersQuery = supabase.from('customers').select('*')
  const [customersResult, customerGroupsResult, productsResult, productGroupsResult, dailyOptions] =
    await Promise.all([
      ['admin', 'finance'].includes(profile.role)
        ? customersQuery.order('name')
        : customersQuery.eq('created_by', profile.id).order('name'),
      supabase.from('customer_groups').select('*').order('name'),
      supabase.from('products').select('*').eq('is_active', true).order('name'),
      supabase.from('product_groups').select('*').order('sort_order'),
      fetchDailyOrderOptions(supabase),
    ])

  const error =
    customersResult.error ||
    customerGroupsResult.error ||
    productsResult.error ||
    productGroupsResult.error
  if (error) throw new Error(`订单基础数据读取失败：${error.message}`)

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" className="h-8 w-8">
          <Link href="/finance/daily-orders"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">新建业务订单</h1>
          <p className="text-sm text-muted-foreground">
            先创建订单草稿，再登记每笔收款及截图凭证。
          </p>
        </div>
      </div>
      <BusinessOrderForm
        profile={profile}
        customers={(customersResult.data ?? []) as Customer[]}
        customerGroups={(customerGroupsResult.data ?? []) as CustomerGroup[]}
        productGroups={(productGroupsResult.data ?? []) as ProductGroup[]}
        products={(productsResult.data ?? []) as Product[]}
        shops={dailyOptions.shops}
        salespeople={dailyOptions.salespeople}
      />
    </div>
  )
}
