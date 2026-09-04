import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { DailyOrderImporter } from '@/components/finance/daily-order-importer'
import { Button } from '@/components/ui/button'
import { requireFinanceAccess } from '@/lib/auth'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'

export default async function ImportDailyOrdersPage() {
  await requireFinanceAccess()
  const supabase = await createClient()
  const options = await fetchDailyOrderOptions(supabase)
  return <div className="space-y-6"><div className="flex items-center gap-3"><Button asChild variant="ghost" size="icon"><Link href="/finance/daily-orders"><ArrowLeft className="h-4 w-4" /></Link></Button><div><h1 className="text-2xl font-semibold">批量导入每日订单</h1><p className="text-sm text-muted-foreground">自动映射中英文表头，并在提交前校对。</p></div></div><DailyOrderImporter {...options} /></div>
}
