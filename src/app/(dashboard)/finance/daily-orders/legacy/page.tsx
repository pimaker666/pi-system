import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { DailyOrderTable } from '@/components/finance/daily-order-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { requireApproved } from '@/lib/auth'
import { parseDailyOrderFilters } from '@/lib/daily-orders'
import { fetchDailyOrderOptions, fetchDailyOrders } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'
import { displayProfileName } from '@/lib/utils'

export default async function LegacyDailyOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireApproved()
  const filters = parseDailyOrderFilters(await searchParams)
  const supabase = await createClient()
  const [orders, options] = await Promise.all([
    fetchDailyOrders(supabase, filters, 500, true),
    fetchDailyOrderOptions(supabase),
  ])

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" className="h-8 w-8">
          <Link href="/finance/daily-orders"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">历史每日订单台账</h1>
          <p className="text-sm text-muted-foreground">
            旧系统订单仅供查询和对账，不能再新增、修改或作废；新订单统一在“每日订单”中管理。
          </p>
        </div>
      </div>

      <form className="grid gap-3 rounded-md border p-4 md:grid-cols-4 xl:grid-cols-8">
        <Input name="q" defaultValue={filters.q} placeholder="订单/发货单/产品/SKU" className="xl:col-span-2" />
        <Input name="dateFrom" type="date" defaultValue={filters.dateFrom} />
        <Input name="dateTo" type="date" defaultValue={filters.dateTo} />
        <select name="shop" defaultValue={filters.shop ?? ''} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">全部店铺</option>
          {options.shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
        </select>
        <select name="salesperson" defaultValue={filters.salesperson ?? ''} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">全部业务员</option>
          {options.salespeople.map((person) => <option key={person.id} value={person.id}>{displayProfileName(person)}</option>)}
        </select>
        <select name="category" defaultValue={filters.category ?? ''} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">全部发货分类</option>
          <option value="stock">现货</option>
          <option value="sample">样品</option>
          <option value="custom">定制</option>
          <option value="purchase">外采</option>
        </select>
        <select name="payment" defaultValue={filters.payment ?? ''} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">全部收款分类</option>
          <option value="full">全款</option>
          <option value="deposit">定金</option>
          <option value="balance">尾款</option>
        </select>
        <div className="flex gap-2 xl:col-span-8">
          <Button type="submit">筛选</Button>
          <Button asChild type="button" variant="outline"><Link href="/finance/daily-orders/legacy">清空</Link></Button>
        </div>
      </form>

      <DailyOrderTable orders={orders} readOnly />
    </div>
  )
}
