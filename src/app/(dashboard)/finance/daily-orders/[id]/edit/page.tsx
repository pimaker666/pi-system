import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { DailyOrderForm } from '@/components/finance/daily-order-form'
import { Button } from '@/components/ui/button'
import { requireFinanceAccess } from '@/lib/auth'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'
import type { DailyOrder } from '@/types'

export default async function EditDailyOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const profile = await requireFinanceAccess()
  const { id } = await params
  const supabase = await createClient()
  const [orderResult, options] = await Promise.all([
    supabase.from('finance_daily_orders').select('*, finance_daily_order_screenshots(*)').eq('id', id).eq('status', 'active').single(),
    fetchDailyOrderOptions(supabase),
  ])
  if (orderResult.error || !orderResult.data) notFound()
  return <div className="space-y-6"><div className="flex items-center gap-3"><Button asChild variant="ghost" size="icon"><Link href="/finance/daily-orders"><ArrowLeft className="h-4 w-4" /></Link></Button><div><h1 className="text-2xl font-semibold">编辑每日订单行</h1><p className="text-sm text-muted-foreground">使用版本号进行并发冲突保护。</p></div></div><DailyOrderForm profileId={profile.id} initialOrder={orderResult.data as DailyOrder} {...options} /></div>
}
