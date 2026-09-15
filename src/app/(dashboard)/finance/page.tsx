import Link from 'next/link'
import { Banknote, CircleDollarSign, ReceiptText, TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { BUSINESS_ORDER_STATUS_LABELS, BUSINESS_ORDER_STATUS_VARIANTS } from '@/lib/business-orders'
import { requireFinanceAccess } from '@/lib/auth'
import { formatCny } from '@/lib/finance'
import { createClient } from '@/lib/supabase/server'
import { formatDate, displayProfileName } from '@/lib/utils'
import type { BusinessOrder, BusinessOrderStatus, FinanceOrder } from '@/types'

interface FinanceSummaryRow {
  order_revenue: number
  income: number
  expense: number
  order_costs: number
  gross_profit: number
  cash_balance: number
}

interface RecentOrder {
  id: string
  orderDate: string
  reference: string
  customer: string
  salesperson: string
  amountCny: number | null
  href?: string
  status?: BusinessOrderStatus
}

export default async function FinanceOverviewPage() {
  await requireFinanceAccess()
  const supabase = await createClient()

  const [summaryResult, legacyOrdersResult, businessOrdersResult] = await Promise.all([
    supabase.rpc('get_finance_summary').single(),
    supabase
      .from('finance_orders')
      .select('id, order_date, pi_number_snapshot, customer_name_snapshot, salesperson_name_snapshot, salesperson_display_name_snapshot, amount_cny, salesperson:profiles!salesperson_id(id, chinese_name, full_name, email)')
      .eq('status', 'active')
      .order('order_date', { ascending: false })
      .limit(8),
    supabase
      .from('business_orders')
      .select('id, order_number, status, order_date, customer_snapshot, salesperson_name_snapshot, salesperson_display_name_snapshot, total_cny, salesperson:profiles!salesperson_id(id, chinese_name, full_name, email)')
      .order('order_date', { ascending: false })
      .limit(8),
  ])

  if (summaryResult.error) throw new Error(`财务汇总读取失败：${summaryResult.error.message}`)
  if (legacyOrdersResult.error) throw new Error(`历史订单读取失败：${legacyOrdersResult.error.message}`)
  if (businessOrdersResult.error) throw new Error(`业务订单读取失败：${businessOrdersResult.error.message}`)

  const rawSummary = summaryResult.data as FinanceSummaryRow
  const summary = {
    orderRevenue: Number(rawSummary.order_revenue),
    income: Number(rawSummary.income),
    expense: Number(rawSummary.expense),
    orderCosts: Number(rawSummary.order_costs),
    grossProfit: Number(rawSummary.gross_profit),
    cashBalance: Number(rawSummary.cash_balance),
  }
  const legacyOrders: RecentOrder[] = ((legacyOrdersResult.data ?? []) as unknown as Array<
    Pick<
      FinanceOrder,
      | 'id'
      | 'order_date'
      | 'pi_number_snapshot'
      | 'customer_name_snapshot'
      | 'salesperson_name_snapshot'
      | 'salesperson_display_name_snapshot'
      | 'amount_cny'
      | 'salesperson'
    >
  >).map((order) => ({
    id: `legacy-${order.id}`,
    orderDate: order.order_date,
    reference: order.pi_number_snapshot,
    customer: order.customer_name_snapshot || '—',
    salesperson: displayProfileName(
      order.salesperson,
      order.salesperson_display_name_snapshot ?? order.salesperson_name_snapshot,
    ),
    amountCny: Number(order.amount_cny),
  }))
  const businessOrders: RecentOrder[] = ((businessOrdersResult.data ?? []) as unknown as Array<
    Pick<
      BusinessOrder,
      | 'id'
      | 'order_number'
      | 'status'
      | 'order_date'
      | 'customer_snapshot'
      | 'salesperson_name_snapshot'
      | 'salesperson_display_name_snapshot'
      | 'total_cny'
      | 'salesperson'
    >
  >).map((order) => {
    const customer = order.customer_snapshot as { name?: string | null; company?: string | null }
    return {
      id: order.id,
      orderDate: order.order_date,
      reference: order.order_number,
      customer: customer.company || customer.name || '—',
      salesperson: displayProfileName(
        order.salesperson,
        order.salesperson_display_name_snapshot ?? order.salesperson_name_snapshot,
      ),
      amountCny: order.total_cny === null ? null : Number(order.total_cny),
      href: `/finance/performance/${order.id}`,
      status: order.status as BusinessOrderStatus,
    }
  })
  const orders = [...businessOrders, ...legacyOrders]
    .sort((a, b) => b.orderDate.localeCompare(a.orderDate))
    .slice(0, 8)
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
          汇总历史财务记录与新业务订单；订单毛利包含已完成订单的归集成本及工资/提成。
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => {
          const Icon = card.icon
          return (
            <Card key={card.label}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">{card.label}</CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent><div className="text-2xl font-bold tabular-nums">{formatCny(card.value)}</div></CardContent>
            </Card>
          )
        })}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">收入合计</CardTitle></CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">{formatCny(summary.income)}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">支出合计</CardTitle></CardHeader>
          <CardContent className="text-2xl font-semibold tabular-nums">{formatCny(summary.expense)}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">最近业务订单</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>日期</TableHead>
                <TableHead>订单 / 客户</TableHead>
                <TableHead>业务员</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">折合人民币</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>{formatDate(order.orderDate)}</TableCell>
                  <TableCell>
                    {order.href ? <Link href={order.href} className="font-medium hover:underline">{order.reference}</Link> : <div className="font-medium">{order.reference}</div>}
                    <div className="text-xs text-muted-foreground">{order.customer}</div>
                  </TableCell>
                  <TableCell>{order.salesperson}</TableCell>
                  <TableCell>
                    {order.status ? (
                      <Badge variant={BUSINESS_ORDER_STATUS_VARIANTS[order.status]}>{BUSINESS_ORDER_STATUS_LABELS[order.status]}</Badge>
                    ) : (
                      <Badge variant="secondary">历史记录</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{order.amountCny === null ? '—' : formatCny(order.amountCny)}</TableCell>
                </TableRow>
              ))}
              {orders.length === 0 && (
                <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">暂无订单业绩</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
