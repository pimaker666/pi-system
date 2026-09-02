import { Banknote, CircleDollarSign, ReceiptText, TrendingUp } from 'lucide-react'
import { requireFinanceAccess } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { formatCny } from '@/lib/finance'
import { formatDate } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { FinanceOrder } from '@/types'

interface FinanceSummaryRow {
  order_revenue: number
  income: number
  expense: number
  order_costs: number
  gross_profit: number
  cash_balance: number
}

export default async function FinanceOverviewPage() {
  await requireFinanceAccess()
  const supabase = await createClient()

  const [summaryResult, ordersResult] = await Promise.all([
    supabase.rpc('get_finance_summary').single(),
    supabase
      .from('finance_orders')
      .select(
        'id, order_date, pi_number_snapshot, customer_name_snapshot, salesperson_name_snapshot, amount_cny',
      )
      .order('order_date', { ascending: false })
      .limit(8),
  ])

  if (summaryResult.error) {
    throw new Error(`财务汇总读取失败：${summaryResult.error.message}`)
  }
  if (ordersResult.error) {
    throw new Error(`最近订单读取失败：${ordersResult.error.message}`)
  }

  const rawSummary = summaryResult.data as FinanceSummaryRow
  const summary = {
    orderRevenue: Number(rawSummary.order_revenue),
    income: Number(rawSummary.income),
    expense: Number(rawSummary.expense),
    orderCosts: Number(rawSummary.order_costs),
    grossProfit: Number(rawSummary.gross_profit),
    cashBalance: Number(rawSummary.cash_balance),
  }
  const orders = (ordersResult.data ?? []) as Pick<
    FinanceOrder,
    | 'id'
    | 'order_date'
    | 'pi_number_snapshot'
    | 'customer_name_snapshot'
    | 'salesperson_name_snapshot'
    | 'amount_cny'
  >[]
  const cards = [
    { label: '订单业绩', value: summary.orderRevenue, icon: CircleDollarSign },
    { label: '订单成本', value: summary.orderCosts, icon: ReceiptText },
    { label: '订单毛利', value: summary.grossProfit, icon: TrendingUp },
    { label: '现金收支净额', value: summary.cashBalance, icon: Banknote },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">财务总览</h1>
        <p className="text-sm text-muted-foreground">
          所有金额按登记时汇率折算为人民币；订单毛利为订单业绩减订单成本。
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => {
          const Icon = card.icon
          return (
            <Card key={card.label}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {card.label}
                </CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tabular-nums">{formatCny(card.value)}</div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">收入合计</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatCny(summary.income)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">支出合计</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">
            {formatCny(summary.expense)}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">最近登记的订单业绩</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>日期</TableHead>
                <TableHead>PI / 客户</TableHead>
                <TableHead>业务员</TableHead>
                <TableHead className="text-right">折合人民币</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.slice(0, 8).map((order) => (
                <TableRow key={order.id}>
                  <TableCell>{formatDate(order.order_date)}</TableCell>
                  <TableCell>
                    <div className="font-medium">{order.pi_number_snapshot}</div>
                    <div className="text-xs text-muted-foreground">
                      {order.customer_name_snapshot || '—'}
                    </div>
                  </TableCell>
                  <TableCell>{order.salesperson_name_snapshot || '—'}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatCny(Number(order.amount_cny))}
                  </TableCell>
                </TableRow>
              ))}
              {orders.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                    暂无订单业绩
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
