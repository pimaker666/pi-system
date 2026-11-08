import { Suspense } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  Banknote,
  CircleDollarSign,
  ReceiptText,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CashTrendChart, type CashTrendPoint } from '@/components/finance/cash-trend-chart'
import { BUSINESS_ORDER_STATUS_LABELS, BUSINESS_ORDER_STATUS_VARIANTS } from '@/lib/business-orders'
import { fetchBusinessOrderCostTodoSummary } from '@/lib/business-order-costs-server'
import { getFinancePageAccess, requireFinancePage } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import {
  FINANCE_OVERVIEW_RANGES,
  mapFinanceOverviewRow,
  parseFinanceOverviewRange,
  resolveFinanceOverviewRange,
} from '@/lib/finance-overview'
import { fetchDashboardReceivables } from '@/lib/dashboard-todos-server'
import { formatCny } from '@/lib/finance'
import { displayProfileName, formatCurrency, formatDate } from '@/lib/utils'
import type { BusinessOrderStatus, CustomerSnapshot, FinanceOrder } from '@/types'

interface RecentOrder {
  id: string
  reference: string
  customer: string
  customerMissing: boolean
  salesperson: string
  orderDate: string
  status: BusinessOrderStatus | null
  currency: string
  originalAmount: number
  amountCny: number | null
}

interface BusinessOrderRow {
  id: string
  order_number: string
  status: BusinessOrderStatus
  order_date: string
  customer_snapshot: CustomerSnapshot | null
  salesperson_name_snapshot: string | null
  salesperson_display_name_snapshot: string | null
  currency: string
  total_amount: number
  total_cny: number | null
  salesperson?: Parameters<typeof displayProfileName>[0]
}

interface FinanceOverviewRow {
  order_revenue: number | string | null
  income: number | string | null
  expense: number | string | null
  order_costs: number | string | null
  gross_profit: number | string | null
  cash_balance: number | string | null
  completed_order_count: number | string | null
  in_progress_order_count: number | string | null
  in_progress_totals: Record<string, number | string> | null
  unpriced_completed_order_count: number | string | null
}

function formatTotals(totals: { currency: string; amount: number }[]) {
  return totals.map((row) => formatCurrency(row.amount, row.currency)).join(' · ')
}

function RiskCard({
  href,
  icon: Icon,
  label,
  hint,
  value,
  unit,
  tone,
}: {
  href: string
  icon: React.ComponentType<{ className?: string }>
  label: string
  hint: string
  value: string
  unit: string
  tone: 'red' | 'amber' | 'blue'
}) {
  const toneClass = {
    red: 'bg-red-50 text-red-600',
    amber: 'bg-amber-50 text-amber-600',
    blue: 'bg-blue-50 text-blue-600',
  }[tone]
  return (
    <Link href={href} className="group">
      <Card className="h-full transition-colors group-hover:border-primary/40">
        <CardContent className="flex items-center gap-3 p-4">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${toneClass}`}>
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{label}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xl font-semibold tabular-nums">{value}</p>
            <p className="text-xs text-muted-foreground">{unit}</p>
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}

function RiskStripSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {[1, 2, 3].map((key) => (
        <div key={key} className="h-[74px] animate-pulse rounded-xl border bg-muted/40" />
      ))}
    </div>
  )
}

/** 风险带是跨全部时间的快照，不随上方区间筛选变化，单独流式加载。 */
async function FinanceRiskStrip({
  showCosts,
  cacheKey,
}: {
  showCosts: boolean
  cacheKey: string
}) {
  const supabase = await createClient()
  const [receivables, costs] = await Promise.all([
    fetchDashboardReceivables(supabase),
    showCosts
      ? fetchBusinessOrderCostTodoSummary(supabase, cacheKey).catch(() => null)
      : Promise.resolve(null),
  ])

  const receivableHint = [
    ...receivables.totals.map((row) => formatCurrency(row.amount, row.currency)),
    receivables.overdueCount > 0 ? `逾期 ${receivables.overdueCount} 单` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <RiskCard
        href="/finance/daily-orders?balanceStatuses=unsettled&settlementStatuses=all"
        icon={Wallet}
        label="未收尾款"
        hint={receivableHint || '所有订单已收齐'}
        value={String(receivables.orderCount)}
        unit="单"
        tone="amber"
      />
      {showCosts ? (
        <>
          <RiskCard
            href="/finance/costs"
            icon={AlertTriangle}
            label="待填成本"
            hint={
              costs
                ? `${costs.missingCostOrderCount} 笔订单 · 影响毛利与提成`
                : '成本口径读取失败'
            }
            value={costs ? String(costs.missingCostRowCount) : '—'}
            unit="产品行"
            tone="red"
          />
          <RiskCard
            href="/finance/costs"
            icon={ReceiptText}
            label="待结算"
            hint={costs ? `${costs.pendingOrderCount} 笔订单可结算` : '结算口径读取失败'}
            value={costs ? String(costs.pendingRowCount) : '—'}
            unit="产品行"
            tone="blue"
          />
        </>
      ) : null}
    </div>
  )
}

export default async function FinanceOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const profile = await requireFinancePage('overview')
  const access = await getFinancePageAccess()
  const params = await searchParams
  const range = parseFinanceOverviewRange(params.range)
  const { from, to, label } = resolveFinanceOverviewRange(range)
  const supabase = await createClient()

  const [summaryResult, trendResult, businessOrdersResult, legacyOrdersResult] = await Promise.all([
    supabase.rpc('get_finance_overview', { p_from: from, p_to: to }).single(),
    supabase.rpc('get_finance_cash_trend', { p_months: 6 }),
    supabase
      .from('business_orders')
      .select(
        'id, order_number, status, order_date, customer_snapshot, salesperson_name_snapshot, salesperson_display_name_snapshot, currency, total_amount, total_cny, salesperson:profiles!salesperson_id(id, chinese_name, full_name, email)',
      )
      .is('voided_at', null)
      .order('order_date', { ascending: false })
      .limit(8),
    supabase
      .from('finance_orders')
      .select(
        'id, order_date, pi_number_snapshot, customer_name_snapshot, salesperson_name_snapshot, salesperson_display_name_snapshot, amount_original, currency, amount_cny, salesperson:profiles!salesperson_id(id, chinese_name, full_name, email)',
      )
      .eq('status', 'active')
      .order('order_date', { ascending: false })
      .limit(8),
  ])

  if (summaryResult.error) throw new Error(`财务汇总读取失败：${summaryResult.error.message}`)
  if (trendResult.error) throw new Error(`现金趋势读取失败：${trendResult.error.message}`)
  if (businessOrdersResult.error) {
    throw new Error(`业务订单读取失败：${businessOrdersResult.error.message}`)
  }
  if (legacyOrdersResult.error) {
    throw new Error(`历史订单读取失败：${legacyOrdersResult.error.message}`)
  }

  const summary = mapFinanceOverviewRow((summaryResult.data ?? {}) as FinanceOverviewRow)
  const trendPoints: CashTrendPoint[] = (
    (trendResult.data ?? []) as { month: string; income: number | string; expense: number | string }[]
  ).map((row) => ({
    month: row.month,
    income: Number(row.income),
    expense: Number(row.expense),
  }))

  const businessOrders: RecentOrder[] = (
    (businessOrdersResult.data ?? []) as unknown as BusinessOrderRow[]
  ).map((order) => {
    const customer = order.customer_snapshot
    const customerLabel = customer?.company || customer?.name || ''
    return {
      id: order.id,
      reference: order.order_number,
      customer: customerLabel || '客户待补',
      customerMissing: !customerLabel,
      salesperson: displayProfileName(
        order.salesperson,
        order.salesperson_display_name_snapshot ?? order.salesperson_name_snapshot,
      ),
      orderDate: order.order_date,
      status: order.status,
      currency: order.currency,
      originalAmount: Number(order.total_amount),
      amountCny: order.total_cny === null ? null : Number(order.total_cny),
    }
  })

  const legacyOrders: RecentOrder[] = ((legacyOrdersResult.data ?? []) as unknown as Array<
    Pick<
      FinanceOrder,
      | 'id'
      | 'order_date'
      | 'pi_number_snapshot'
      | 'customer_name_snapshot'
      | 'salesperson_name_snapshot'
      | 'salesperson_display_name_snapshot'
      | 'amount_original'
      | 'currency'
      | 'amount_cny'
      | 'salesperson'
    >
  >).map((order) => ({
    id: `legacy-${order.id}`,
    reference: order.pi_number_snapshot,
    customer: order.customer_name_snapshot || '客户待补',
    customerMissing: !order.customer_name_snapshot,
    salesperson: displayProfileName(
      order.salesperson,
      order.salesperson_display_name_snapshot ?? order.salesperson_name_snapshot,
    ),
    orderDate: order.order_date,
    status: null,
    currency: order.currency,
    originalAmount: Number(order.amount_original),
    amountCny: Number(order.amount_cny),
  }))

  const recentOrders = [...businessOrders, ...legacyOrders]
    .sort((a, b) => b.orderDate.localeCompare(a.orderDate))
    .slice(0, 8)

  const inProgressTotals = formatTotals(summary.inProgressTotals)
  const grossMargin =
    summary.orderRevenue > 0
      ? `${((summary.grossProfit / summary.orderRevenue) * 100).toFixed(1)}%`
      : null
  const completedTotal = summary.completedOrderCount + summary.inProgressOrderCount
  const completedRatio = completedTotal > 0 ? (summary.completedOrderCount / completedTotal) * 100 : 0

  const cards = [
    {
      label: '订单业绩',
      chip: '已完成订单',
      tone: 'blue' as const,
      value: formatCny(summary.orderRevenue),
      hint: [
        `${summary.completedOrderCount} 笔已完成`,
        summary.inProgressOrderCount > 0 ? `进行中 ${summary.inProgressOrderCount} 笔` : null,
        summary.unpricedCompletedOrderCount > 0
          ? `${summary.unpricedCompletedOrderCount} 笔待核汇率`
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
      icon: CircleDollarSign,
    },
    {
      label: '订单成本',
      chip: '已完成订单',
      tone: 'muted' as const,
      value: formatCny(summary.orderCosts),
      hint: '归集成本，含工资与提成',
      icon: ReceiptText,
    },
    {
      label: '订单毛利',
      chip: grossMargin ? `毛利率 ${grossMargin}` : '毛利率 —',
      tone: 'green' as const,
      value: formatCny(summary.grossProfit),
      hint: '订单业绩 − 归集成本',
      icon: TrendingUp,
    },
    {
      label: '现金收支净额',
      chip: '财务日记账',
      tone: 'amber' as const,
      value: formatCny(summary.cashBalance),
      hint: `收入 ${formatCny(summary.income)} · 支出 ${formatCny(summary.expense)}`,
      icon: Banknote,
    },
  ]

  const toneClass = {
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    muted: 'border-transparent bg-muted text-muted-foreground',
    green: 'border-transparent bg-green-100 text-green-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">财务总览</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            订单业绩与毛利只统计已完成订单；现金收支来自财务日记账与客户转账。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {FINANCE_OVERVIEW_RANGES.map((option) => (
            <Button
              key={option.value}
              asChild
              size="sm"
              variant={option.value === range ? 'default' : 'outline'}
            >
              <Link href={option.value === 'month' ? '/finance' : `/finance?range=${option.value}`}>
                {option.label}
              </Link>
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => {
          const Icon = card.icon
          return (
            <Card key={card.label}>
              <CardContent className="space-y-2 p-5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                    <Icon className="h-4 w-4" />
                    {card.label}
                  </span>
                  <Badge variant="outline" className={toneClass[card.tone]}>
                    {card.chip}
                  </Badge>
                </div>
                <div className="text-2xl font-bold tabular-nums">{card.value}</div>
                <p className="truncate text-xs text-muted-foreground" title={card.hint}>
                  {card.hint}
                </p>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Suspense fallback={<RiskStripSkeleton />}>
        <FinanceRiskStrip showCosts={access.costs} cacheKey={profile.id} />
      </Suspense>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-base">近 6 个月现金收支</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                收入含财务日记账与客户转账，支出取财务日记账
              </p>
            </div>
          </CardHeader>
          <CardContent>
            <CashTrendChart points={trendPoints} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-base">订单完成情况</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">业绩与毛利仅统计已完成订单</p>
            </div>
            <Badge variant="outline">{label}</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="bg-blue-500"
                style={{ width: `${completedRatio}%` }}
                aria-hidden
              />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span>
                已完成 <b className="tabular-nums">{summary.completedOrderCount}</b> 笔
              </span>
              <span>
                进行中 <b className="tabular-nums">{summary.inProgressOrderCount}</b> 笔
              </span>
            </div>
            <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              进行中金额：{inProgressTotals || '暂无'}
            </div>
            {summary.unpricedCompletedOrderCount > 0 ? (
              <p className="flex items-start gap-1.5 text-xs text-amber-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {summary.unpricedCompletedOrderCount} 笔已完成订单缺汇率，暂未计入业绩与毛利
              </p>
            ) : null}
            <Button asChild variant="outline" size="sm" className="w-full">
              <Link href="/finance/daily-orders?settlementStatuses=all">查看订单台账</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">最近业务订单</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              保留原币金额；缺汇率时显示「待核汇率」，不再用「—」隐藏
            </p>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link href="/finance/daily-orders?settlementStatuses=all">查看全部</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {recentOrders.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">暂无订单业绩</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead>订单 / 客户</TableHead>
                  <TableHead>业务员</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">原币金额</TableHead>
                  <TableHead className="text-right">折合人民币</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentOrders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="text-muted-foreground">
                      {formatDate(order.orderDate)}
                    </TableCell>
                    <TableCell>
                      {order.status ? (
                        <Link
                          href={`/finance/daily-orders/${order.id}`}
                          className="font-medium hover:underline"
                        >
                          {order.reference}
                        </Link>
                      ) : (
                        <div className="font-medium">{order.reference}</div>
                      )}
                      <div
                        className={
                          order.customerMissing
                            ? 'text-xs text-amber-600'
                            : 'text-xs text-muted-foreground'
                        }
                      >
                        {order.customer}
                      </div>
                    </TableCell>
                    <TableCell>{order.salesperson}</TableCell>
                    <TableCell>
                      {order.status ? (
                        <Badge variant={BUSINESS_ORDER_STATUS_VARIANTS[order.status]}>
                          {BUSINESS_ORDER_STATUS_LABELS[order.status]}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">历史记录</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(order.originalAmount, order.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {order.amountCny === null ? (
                        <Badge variant="outline" className={toneClass.amber}>
                          待核汇率
                        </Badge>
                      ) : (
                        formatCny(order.amountCny)
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
