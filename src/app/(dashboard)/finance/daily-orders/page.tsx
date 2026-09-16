import Link from 'next/link'
import { Archive, CreditCard, Plus, Settings, Upload } from 'lucide-react'
import { BusinessDailyOrderTable } from '@/components/finance/business-daily-order-table'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { requireApproved } from '@/lib/auth'
import {
  businessDailyCurrencyOrder,
  businessDailyOrderTotals,
  type BusinessDailyLedgerOrder,
} from '@/lib/business-daily-orders'
import {
  BUSINESS_DAILY_LEDGER_LIMIT,
  fetchBusinessDailyLedger,
} from '@/lib/business-daily-orders-server'
import { dailyOrderFilterQuery, formatDailyMoney, parseDailyOrderFilters } from '@/lib/daily-orders'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'
import { displayProfileName } from '@/lib/utils'
import type { CurrencyCode } from '@/types'

type CurrencyTotals = Partial<Record<CurrencyCode, number>>

function sumOrdersByCurrency(
  orders: BusinessDailyLedgerOrder[],
  getAmount: (order: BusinessDailyLedgerOrder) => number,
): CurrencyTotals {
  return orders.reduce<CurrencyTotals>((totals, order) => {
    totals[order.currency] = (totals[order.currency] ?? 0) + getAmount(order)
    return totals
  }, {})
}

const TOTAL_CARDS: Array<{
  label: string
  totals: (orders: BusinessDailyLedgerOrder[]) => CurrencyTotals
}> = [
  {
    label: '订单总金额',
    totals: (orders) => sumOrdersByCurrency(orders, (order) => Number(order.total_amount)),
  },
  {
    label: '产品实收',
    totals: (orders) =>
      sumOrdersByCurrency(orders, (order) => businessDailyOrderTotals(order).productReceived),
  },
  {
    label: '运费实收',
    totals: (orders) =>
      sumOrdersByCurrency(orders, (order) => businessDailyOrderTotals(order).shippingReceived),
  },
  {
    label: '实际实收总额',
    totals: (orders) => {
      const product = sumOrdersByCurrency(
        orders,
        (order) => businessDailyOrderTotals(order).productReceived,
      )
      const shipping = sumOrdersByCurrency(
        orders,
        (order) => businessDailyOrderTotals(order).shippingReceived,
      )
      const currencies = new Set<CurrencyCode>([
        ...(Object.keys(product) as CurrencyCode[]),
        ...(Object.keys(shipping) as CurrencyCode[]),
      ])
      const totals: CurrencyTotals = {}
      for (const currency of currencies) {
        totals[currency] = (product[currency] ?? 0) + (shipping[currency] ?? 0)
      }
      return totals
    },
  },
  {
    label: '未收尾款',
    totals: (orders) => sumOrdersByCurrency(orders, (order) => order.outstanding_amount),
  },
]

export default async function DailyOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const profile = await requireApproved()
  const filters = parseDailyOrderFilters(await searchParams)
  const supabase = await createClient()
  const [orders, options] = await Promise.all([
    fetchBusinessDailyLedger(supabase, filters),
    fetchDailyOrderOptions(supabase),
  ])
  const query = dailyOrderFilterQuery(filters)
  const canManageShops = profile.role === 'finance' || profile.role === 'admin'
  const canCreate = ['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">财务每日订单台账</h1>
          <p className="text-sm text-muted-foreground">
            每行对应一个产品；当前筛选最多显示与导出 {BUSINESS_DAILY_LEDGER_LIMIT} 行。
            建单、收款、发货、退货与结单全部使用业务订单作为单一事实源。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/finance/daily-orders/legacy"><Archive className="h-4 w-4" />历史台账</Link>
          </Button>
          {canManageShops && (
            <>
              <Button asChild variant="outline">
                <Link href="/finance/daily-orders/settings"><Settings className="h-4 w-4" />店铺设置</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/finance/daily-orders/settings"><CreditCard className="h-4 w-4" />收款账户</Link>
              </Button>
            </>
          )}
          {canCreate && (
            <>
              <Button asChild variant="outline">
                <Link href="/finance/daily-orders/import"><Upload className="h-4 w-4" />批量导入</Link>
              </Button>
              <Button asChild>
                <Link href="/finance/daily-orders/new"><Plus className="h-4 w-4" />新建订单</Link>
              </Button>
            </>
          )}
        </div>
      </div>

      <form className="grid gap-3 rounded-md border p-4 md:grid-cols-4 xl:grid-cols-8">
        <Input name="q" defaultValue={filters.q} placeholder="订单号/平台单号/发货单号/收款账户/产品/SKU" className="xl:col-span-2" />
        <Input name="dateFrom" type="date" defaultValue={filters.dateFrom} />
        <Input name="dateTo" type="date" defaultValue={filters.dateTo} />
        <select name="shop" defaultValue={filters.shop ?? ''} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">全部店铺</option>
          {options.shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
        </select>
        <select name="shopGroup" defaultValue={filters.shopGroup ?? ''} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">全部店铺分组</option>
          {options.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
        <select name="salesperson" defaultValue={filters.salesperson ?? ''} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">全部业务员</option>
          {options.salespeople.map((person) => (
            <option key={person.id} value={person.id}>{displayProfileName(person)}</option>
          ))}
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
        <select name="completion" defaultValue={filters.completion ?? ''} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">全部状态</option>
          <option value="completed">已完成</option>
          <option value="incomplete">未完成</option>
        </select>
        <div className="flex flex-wrap gap-2 xl:col-span-8">
          <Button type="submit">筛选</Button>
          <Button asChild type="button" variant="outline">
            <Link href="/finance/daily-orders">清空</Link>
          </Button>
        </div>
      </form>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {TOTAL_CARDS.map(({ label, totals }) => {
          const totalsByCurrency = totals(orders)
          return (
            <Card key={label}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">{label}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 font-semibold tabular-nums">
                {businessDailyCurrencyOrder(totalsByCurrency).map((currency) => (
                  <div key={currency}>{formatDailyMoney(totalsByCurrency[currency] ?? 0, currency)}</div>
                ))}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <BusinessDailyOrderTable orders={orders} actor={profile} filterQuery={query} />
    </div>
  )
}
