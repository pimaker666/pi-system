import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { DailyOrderTable } from '@/components/finance/daily-order-table'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import {
  formatDailyMoney,
  parseDailyOrderFilters,
  sumDailyOrdersByCurrency,
} from '@/lib/daily-orders'
import { fetchDailyOrders } from '@/lib/daily-orders-server'

export default async function TeamDailyOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const profile = await requireApproved()
  if (profile.role !== 'supervisor') redirect('/finance/performance')

  const raw = await searchParams
  const filters = parseDailyOrderFilters(raw)
  const supabase = await createClient()
  // 行级安全策略仅返回本主管递归下属业务员的订单，无需在此附加 salesperson 过滤。
  const orders = await fetchDailyOrders(supabase, filters, 500, true)
  const totals = [
    ['产品实收', sumDailyOrdersByCurrency(orders, 'product_received')],
    ['物流费用', sumDailyOrdersByCurrency(orders, 'logistics_fee')],
    ['销售总额', sumDailyOrdersByCurrency(orders, 'sales_total')],
  ] as const

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">团队每日订单台账</h1>
        <p className="text-sm text-muted-foreground">
          仅查看你下属业务员的每日订单；当前筛选最多显示 500 行。
        </p>
      </div>
      <form className="grid gap-3 rounded-md border p-4 md:grid-cols-4">
        <Input
          name="q"
          defaultValue={filters.q}
          placeholder="订单/发货单/产品/SKU"
          className="md:col-span-2"
        />
        <Input name="dateFrom" type="date" defaultValue={filters.dateFrom} />
        <Input name="dateTo" type="date" defaultValue={filters.dateTo} />
        <div className="flex gap-2 md:col-span-4">
          <Button type="submit">筛选</Button>
          <Button asChild type="button" variant="outline">
            <Link href="/finance/performance/daily-orders">清空</Link>
          </Button>
        </div>
      </form>
      <div className="grid gap-4 md:grid-cols-3">
        {totals.map(([label, values]) => (
          <Card key={label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 font-semibold tabular-nums">
              <div>{formatDailyMoney(values.CNY, 'CNY')}</div>
              <div>{formatDailyMoney(values.USD, 'USD')}</div>
            </CardContent>
          </Card>
        ))}
      </div>
      <DailyOrderTable orders={orders} readOnly />
    </div>
  )
}
