import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { BusinessDailyOrderImporter } from '@/components/finance/business-daily-order-importer'
import { Button } from '@/components/ui/button'
import { requireApproved } from '@/lib/auth'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'
import type { Customer } from '@/types'

export default async function ImportDailyOrdersPage() {
  const profile = await requireApproved()
  // 导入最终走 create_business_order_v3，可建单角色与新建订单页保持一致。
  if (!['sales', 'supervisor', 'admin'].includes(profile.role)) {
    redirect('/finance/daily-orders')
  }

  const supabase = await createClient()
  const customersQuery = supabase.from('customers').select('id, name')
  const [dailyOptions, customersResult] = await Promise.all([
    fetchDailyOrderOptions(supabase),
    // 客户可见范围与新建订单页一致：管理员看全部，其余只看自己创建的客户。
    profile.role === 'admin'
      ? customersQuery.order('name')
      : customersQuery.eq('created_by', profile.id).order('name'),
  ])
  if (customersResult.error) throw new Error(`客户读取失败：${customersResult.error.message}`)

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" className="h-8 w-8">
          <Link href="/finance/daily-orders"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">批量导入每日订单</h1>
          <p className="text-sm text-muted-foreground">
            上传或粘贴表格后逐行校对，同一订单号的多行会合并为一张订单的多条明细。
          </p>
        </div>
      </div>
      <BusinessDailyOrderImporter
        shops={dailyOptions.shops}
        salespeople={dailyOptions.salespeople}
        products={dailyOptions.products}
        customers={(customersResult.data ?? []) as Pick<Customer, 'id' | 'name'>[]}
      />
    </div>
  )
}
