import Link from 'next/link'
import { Archive, Plus } from 'lucide-react'
import {
  PerformanceManager,
  type BusinessOrderListRow,
} from '@/components/finance/performance-manager'
import { Button } from '@/components/ui/button'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

export default async function DailyOrdersPage() {
  const profile = await requireApproved()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('business_orders')
    .select(
      '*, business_order_payment_allocations(amount, voided_at, transfer:business_customer_transfers!business_order_payment_allocations_transfer_id_fkey(voided_at, exchange_rate_to_cny)), salesperson:profiles!salesperson_id(id, chinese_name, full_name, email)',
    )
    .order('order_date', { ascending: false })
    .order('created_at', { ascending: false })

  if (error) throw new Error(`业务订单读取失败：${error.message}`)
  const orders = (data ?? []) as BusinessOrderListRow[]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">财务每日订单</h1>
          <p className="text-sm text-muted-foreground">
            统一建单、收款、发货、退货与结单入口，全部使用业务订单作为单一事实源。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/finance/daily-orders/legacy">
              <Archive className="h-4 w-4" />历史台账
            </Link>
          </Button>
          {['sales', 'supervisor', 'admin'].includes(profile.role) && (
            <Button asChild>
              <Link href="/finance/daily-orders/new">
                <Plus className="h-4 w-4" />新建订单
              </Link>
            </Button>
          )}
        </div>
      </div>
      <PerformanceManager orders={orders} />
    </div>
  )
}
