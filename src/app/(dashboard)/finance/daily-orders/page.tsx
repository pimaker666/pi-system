import Link from 'next/link'
import { Download, FileText, Plus, Settings, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { DailyOrderTable } from '@/components/finance/daily-order-table'
import { requireFinanceAccess } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { dailyOrderFilterQuery, formatDailyMoney, parseDailyOrderFilters, sumDailyOrdersByCurrency } from '@/lib/daily-orders'
import { fetchDailyOrderOptions, fetchDailyOrders } from '@/lib/daily-orders-server'

export default async function DailyOrdersPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireFinanceAccess()
  const raw = await searchParams
  const filters = parseDailyOrderFilters(raw)
  const supabase = await createClient()
  const [orders, options] = await Promise.all([
    fetchDailyOrders(supabase, filters, 500, true),
    fetchDailyOrderOptions(supabase),
  ])
  const totals = [
    ['产品实收', sumDailyOrdersByCurrency(orders, 'product_received')],
    ['运费实收金额', sumDailyOrdersByCurrency(orders, 'logistics_fee')],
    ['销售总额', sumDailyOrdersByCurrency(orders, 'sales_total')],
  ] as const
  const query = dailyOrderFilterQuery(filters)

  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">财务每日订单台账</h1><p className="text-sm text-muted-foreground">每行对应一个产品；当前筛选最多显示与导出 500 行。</p></div><div className="flex flex-wrap gap-2"><Button asChild variant="outline"><Link href="/finance/daily-orders/settings"><Settings className="h-4 w-4" />店铺设置</Link></Button><Button asChild variant="outline"><Link href="/finance/daily-orders/import"><Upload className="h-4 w-4" />批量导入</Link></Button><Button asChild><Link href="/finance/daily-orders/new"><Plus className="h-4 w-4" />新建</Link></Button></div></div>
    <form className="grid gap-3 rounded-md border p-4 md:grid-cols-4 xl:grid-cols-8">
      <Input name="q" defaultValue={filters.q} placeholder="订单/发货单/产品/SKU" className="xl:col-span-2" />
      <Input name="dateFrom" type="date" defaultValue={filters.dateFrom} />
      <Input name="dateTo" type="date" defaultValue={filters.dateTo} />
      <select name="shop" defaultValue={filters.shop ?? ''} className="h-10 rounded-md border bg-background px-3 text-sm"><option value="">全部店铺</option>{options.shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}</select>
      <select name="salesperson" defaultValue={filters.salesperson ?? ''} className="h-10 rounded-md border bg-background px-3 text-sm"><option value="">全部业务员</option>{options.salespeople.map((person) => <option key={person.id} value={person.id}>{person.full_name || person.email}</option>)}</select>
      <select name="category" defaultValue={filters.category ?? ''} className="h-10 rounded-md border bg-background px-3 text-sm"><option value="">全部发货分类</option><option value="stock">现货</option><option value="sample">样品</option><option value="custom">定制</option><option value="purchase">外采</option></select>
      <select name="payment" defaultValue={filters.payment ?? ''} className="h-10 rounded-md border bg-background px-3 text-sm"><option value="">全部收款分类</option><option value="full">全款</option><option value="deposit">定金</option><option value="balance">尾款</option></select>
      <div className="flex gap-2 xl:col-span-8"><Button type="submit">筛选</Button><Button asChild type="button" variant="outline"><Link href="/finance/daily-orders">清空</Link></Button><Button asChild type="button" variant="outline"><a href={`/api/finance/daily-orders/export/xlsx${query ? `?${query}` : ''}`}><Download className="h-4 w-4" />XLSX</a></Button><Button asChild type="button" variant="outline"><a href={`/api/finance/daily-orders/export/pdf${query ? `?${query}` : ''}`}><FileText className="h-4 w-4" />PDF</a></Button></div>
    </form>
    <div className="grid gap-4 md:grid-cols-3">{totals.map(([label, values]) => <Card key={label}><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{label}</CardTitle></CardHeader><CardContent className="space-y-1 font-semibold tabular-nums"><div>{formatDailyMoney(values.CNY, 'CNY')}</div><div>{formatDailyMoney(values.USD, 'USD')}</div></CardContent></Card>)}</div>
    <DailyOrderTable orders={orders} />
  </div>
}
