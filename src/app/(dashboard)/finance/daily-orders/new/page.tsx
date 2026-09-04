import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { DailyOrderForm } from '@/components/finance/daily-order-form'
import { Button } from '@/components/ui/button'
import { requireFinanceAccess } from '@/lib/auth'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'

export default async function NewDailyOrderPage() {
  const profile = await requireFinanceAccess()
  const supabase = await createClient()
  const options = await fetchDailyOrderOptions(supabase)
  return <div className="space-y-6"><div className="flex items-center gap-3"><Button asChild variant="ghost" size="icon"><Link href="/finance/daily-orders"><ArrowLeft className="h-4 w-4" /></Link></Button><div><h1 className="text-2xl font-semibold">新建每日订单行</h1><p className="text-sm text-muted-foreground">一个订单可添加多个产品，每个产品分别填写发货分类、数量与金额。</p></div></div><DailyOrderForm profileId={profile.id} {...options} /></div>
}
