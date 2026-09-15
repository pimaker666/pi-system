import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { DailyOrderShopManager } from '@/components/finance/daily-order-shop-manager'
import { PaymentAccountManager } from '@/components/finance/payment-account-manager'
import { Button } from '@/components/ui/button'
import { requireFinanceAccess } from '@/lib/auth'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'

export default async function DailyOrderSettingsPage() {
  await requireFinanceAccess()
  const supabase = await createClient()
  const options = await fetchDailyOrderOptions(supabase)
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon">
          <Link href="/finance/daily-orders"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">每日订单设置</h1>
          <p className="text-sm text-muted-foreground">维护店铺分组、启用状态、业务员分配及收款账户。</p>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <DailyOrderShopManager
          shops={options.shops}
          groups={options.groups}
          salespeople={options.salespeople}
        />
        <PaymentAccountManager accounts={options.paymentAccounts} />
      </div>
    </div>
  )
}
