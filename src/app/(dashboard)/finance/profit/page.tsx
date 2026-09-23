import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getBusinessOrderProfitRows } from '@/lib/actions/business-order-profit'
import { getBusinessDateKey } from '@/lib/business-orders'
import { formatDailyMoney } from '@/lib/daily-orders'
import { requireFinanceAccess } from '@/lib/auth'

function currentMonth() {
  return getBusinessDateKey().slice(0, 7)
}

function money(value: number, currency: 'CNY' | 'USD') {
  return formatDailyMoney(value, currency)
}

export default async function FinanceProfitPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireFinanceAccess()
  const raw = await searchParams
  const periodValue = Array.isArray(raw.period) ? raw.period[0] : raw.period
  const period = /^\d{4}-\d{2}$/.test(periodValue ?? '') ? periodValue! : currentMonth()
  const rows = await getBusinessOrderProfitRows({ period })
  const cnyRows = rows.filter((row) => row.currency === 'CNY')
  const usdRows = rows.filter((row) => row.currency === 'USD')
  const total = (items: typeof rows, key: 'received_amount' | 'product_cost' | 'freight_cost' | 'commission_amount' | 'fee_amount' | 'profit_amount') =>
    items.reduce((sum, row) => sum + row[key], 0)
  const dimensions = [
    { label: '业务员', value: (row: (typeof rows)[number]) => row.salesperson_name || '未分配' },
    { label: '店铺', value: (row: (typeof rows)[number]) => row.shop_name || '未分配' },
    { label: '归属月份', value: (row: (typeof rows)[number]) => row.profit_period },
  ]
  const groupSummaries = dimensions.map((dimension) => {
    const groups = new Map<string, { label: string; currency: 'CNY' | 'USD'; count: number; received: number; profit: number }>()
    for (const row of rows) {
      const label = dimension.value(row)
      const key = `${row.currency}:${label}`
      const group = groups.get(key) ?? { label, currency: row.currency, count: 0, received: 0, profit: 0 }
      group.count += 1
      group.received += row.received_amount
      group.profit += row.profit_amount
      groups.set(key, group)
    }
    return { label: dimension.label, rows: [...groups.values()].sort((a, b) => b.profit - a.profit) }
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">利润核算</h1>
        <p className="text-sm text-muted-foreground">仅展示产品成本与提成均已结清的订单；归属月份取两者最后确认的月份。</p>
      </div>
      <form className="flex flex-wrap items-end gap-3 rounded-md border p-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="period">归属月份</label>
          <Input id="period" name="period" type="month" defaultValue={period} />
        </div>
        <Button type="submit">筛选</Button>
        <Button asChild type="button" variant="outline"><Link href="/finance/profit">本月</Link></Button>
      </form>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(['CNY', 'USD'] as const).map((currency) => {
          const items = currency === 'CNY' ? cnyRows : usdRows
          return (
            <div key={currency} className="rounded-md border p-4">
              <div className="text-xs text-muted-foreground">{currency} 已结清订单 / 利润</div>
              <div className="mt-1 text-xl font-semibold">{items.length} 单 / {money(total(items, 'profit_amount'), currency)}</div>
              <div className="mt-1 text-sm text-muted-foreground">实收 {money(total(items, 'received_amount'), currency)} · 扣减 {money(total(items, 'product_cost') + total(items, 'freight_cost') + total(items, 'commission_amount') + total(items, 'fee_amount'), currency)}</div>
            </div>
          )
        })}
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        {groupSummaries.map((summary) => (
          <div key={summary.label} className="overflow-hidden rounded-md border">
            <div className="border-b bg-muted/30 px-4 py-3 text-sm font-medium">按{summary.label}汇总</div>
            <Table>
              <TableHeader><TableRow><TableHead>{summary.label}</TableHead><TableHead className="text-right">订单数</TableHead><TableHead className="text-right">实收</TableHead><TableHead className="text-right">利润</TableHead></TableRow></TableHeader>
              <TableBody>{summary.rows.map((row) => <TableRow key={`${row.currency}:${row.label}`}><TableCell>{row.label}</TableCell><TableCell className="text-right">{row.count}</TableCell><TableCell className="text-right tabular-nums">{money(row.received, row.currency)}</TableCell><TableCell className="text-right font-medium tabular-nums">{money(row.profit, row.currency)}</TableCell></TableRow>)}{summary.rows.length === 0 && <TableRow><TableCell colSpan={4} className="py-6 text-center text-muted-foreground">暂无数据</TableCell></TableRow>}</TableBody>
            </Table>
          </div>
        ))}
      </div>
      <div className="overflow-x-auto rounded-md border">
        <Table className="min-w-[1400px]">
          <TableHeader><TableRow>
            <TableHead>归属月</TableHead><TableHead>订单号</TableHead><TableHead>店铺</TableHead><TableHead>业务员</TableHead>
            <TableHead className="text-right">总实收</TableHead><TableHead className="text-right">产品成本</TableHead><TableHead className="text-right">运费成本</TableHead><TableHead className="text-right">提成</TableHead><TableHead>手续费</TableHead><TableHead className="text-right">利润</TableHead>
          </TableRow></TableHeader>
          <TableBody>{rows.map((row) => <TableRow key={row.order_id}>
            <TableCell>{row.profit_period}</TableCell><TableCell className="font-medium">{row.external_order_number || row.order_number}</TableCell><TableCell>{row.shop_name || '—'}</TableCell><TableCell>{row.salesperson_name || '—'}</TableCell>
            <TableCell className="text-right tabular-nums">{money(row.received_amount, row.currency)}</TableCell><TableCell className="text-right tabular-nums">{money(row.product_cost, row.currency)}</TableCell><TableCell className="text-right tabular-nums">{money(row.freight_cost, row.currency)}</TableCell><TableCell className="text-right tabular-nums">{money(row.commission_amount, row.currency)}</TableCell>
            <TableCell className="text-right tabular-nums">{money(row.fee_amount, row.currency)}</TableCell>
            <TableCell className="text-right font-medium tabular-nums">{money(row.profit_amount, row.currency)}</TableCell>
          </TableRow>)}{rows.length === 0 && <TableRow><TableCell colSpan={10} className="py-12 text-center text-muted-foreground">该月份暂无双结清订单</TableCell></TableRow>}</TableBody>
        </Table>
      </div>
    </div>
  )
}
