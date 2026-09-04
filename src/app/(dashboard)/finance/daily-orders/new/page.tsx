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
  return <div className="space-y-6"><div className="flex items-center gap-3"><Button asChild variant="ghost" size="icon"><Link href="/finance/daily-orders"><ArrowLeft className="h-4 w-4" /></Link></Button><div><h1 className="text-2xl font-semibold">新建每日订单行</h1><p className="text-sm text-muted-foreground">同一订单多个产品请分别创建，订单号可以重复。</p></div></div><DailyOrderForm profileId={profile.id} {...options} /></div>
}
