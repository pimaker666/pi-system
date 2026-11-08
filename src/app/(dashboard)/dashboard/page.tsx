import { Suspense } from 'react'
import Link from 'next/link'
import {
  BadgeDollarSign,
  Calculator,
  CalendarClock,
  ChevronRight,
  ClipboardCheck,
  FilePlus2,
  FileText,
  Package,
  ReceiptText,
  Users,
  Wallet,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getFinancePageAccess, requireApproved } from '@/lib/auth'
import { getDashboardStats } from '@/lib/dashboard-stats'
import {
  currentMonthDateRange,
  fetchDashboardApprovalCount,
  fetchDashboardMonthOrders,
  fetchDashboardPendingCommissionCount,
  fetchDashboardReceivables,
} from '@/lib/dashboard-todos-server'
import { fetchBusinessOrderCostTodoSummary } from '@/lib/business-order-costs-server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { CustomerSnapshot } from '@/types'

interface RecentPi {
  id: string
  pi_number: string
  customer_snapshot: CustomerSnapshot
  currency: string
  total: number
  status: 'active' | 'void'
  created_at: string
}

interface TodoCard {
  key: string
  label: string
  value: number
  hint: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  alert?: boolean
}

function TodoCardView({ todo }: { todo: TodoCard }) {
  const Icon = todo.icon
  return (
    <Link href={todo.href} className="group block">
      <Card className="h-full transition-colors group-hover:border-primary/40 group-hover:bg-accent/40">
        <CardContent className="flex items-start justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{todo.label}</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">{todo.value}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">{todo.hint}</p>
          </div>
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
              todo.alert
                ? 'bg-destructive/10 text-destructive'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            <Icon className="h-5 w-5" />
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}

function TodoCardSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
      <div className="h-3 w-16 animate-pulse rounded bg-muted" />
      <div className="mt-4 h-8 w-20 animate-pulse rounded bg-muted" />
      <div className="mt-3 h-3 w-32 animate-pulse rounded bg-muted" />
    </div>
  )
}

/** 成本待办需要按产品行结算口径全量判定，单独流式加载，避免拖慢工作台首屏。 */
async function CostTodoCards() {
  const supabase = await createClient()
  const profile = await requireApproved()
  let summary
  try {
    summary = await fetchBusinessOrderCostTodoSummary(supabase, profile.id)
  } catch {
    return null
  }
  const cards: TodoCard[] = [
    {
      key: 'missing-cost',
      label: '待填成本',
      value: summary.missingCostOrderCount,
      hint:
        summary.missingCostRowCount > 0
          ? `${summary.missingCostRowCount} 个产品行缺少成本`
          : '可结算成本已全部填写',
      href: '/finance/costs',
      icon: Calculator,
      alert: summary.missingCostRowCount > 0,
    },
    {
      key: 'settlement',
      label: '待结算',
      value: summary.pendingOrderCount,
      hint:
        summary.pendingRowCount > 0
          ? `可结算 ${summary.pendingRowCount} 个产品行`
          : '暂无可结算订单',
      href: '/finance/costs',
      icon: ReceiptText,
    },
  ]
  return (
    <>
      {cards.map((card) => (
        <TodoCardView key={card.key} todo={card} />
      ))}
    </>
  )
}

export default async function DashboardPage() {
  const profile = await requireApproved()
  const supabase = await createClient()
  const financeAccess = await getFinancePageAccess()
  const isSalesperson = profile.role === 'sales' || profile.role === 'supervisor'
  const monthRange = currentMonthDateRange()

  const [stats, { data }, approvals, receivables, monthOrders, commissionPending] =
    await Promise.all([
      getDashboardStats(),
      supabase
        .from('proforma_invoices')
        .select('id, pi_number, customer_snapshot, currency, total, status, created_at')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(8),
      fetchDashboardApprovalCount(supabase),
      fetchDashboardReceivables(supabase),
      fetchDashboardMonthOrders(supabase),
      isSalesperson ? fetchDashboardPendingCommissionCount(supabase) : Promise.resolve(0),
    ])

  const recent = (data ?? []) as RecentPi[]

  const ordersHref = (params: Record<string, string>) =>
    `/finance/daily-orders?${new URLSearchParams(params).toString()}`

  const leadTodo: TodoCard = {
    key: 'approvals',
    label: '待我审批',
    value: approvals,
    hint: approvals > 0 ? '有需要我处理的审批' : '暂无待审批事项',
    href: '/approvals',
    icon: ClipboardCheck,
    alert: approvals > 0,
  }

  const tailTodos: TodoCard[] = []
  if (isSalesperson) {
    tailTodos.push({
      key: 'commission',
      label: '待确认提成',
      value: commissionPending,
      hint: commissionPending > 0 ? '有提成待确认' : '提成已全部确认',
      href: '/finance/commission',
      icon: BadgeDollarSign,
      alert: commissionPending > 0,
    })
  }

  const receivableHint = [
    ...receivables.totals.map((row) => formatCurrency(row.amount, row.currency)),
    receivables.overdueCount > 0 ? `其中逾期 ${receivables.overdueCount} 单` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  tailTodos.push({
    key: 'receivables',
    label: '未收尾款',
    value: receivables.orderCount,
    hint: receivableHint || '所有订单已收齐',
    href: ordersHref({ balanceStatuses: 'unsettled', settlementStatuses: 'all' }),
    icon: Wallet,
    alert: receivables.orderCount > 0,
  })

  const monthHref = ordersHref({
    dateFrom: monthRange.dateFrom,
    dateTo: monthRange.dateTo,
    settlementStatuses: 'all',
  })
  const monthAmounts = monthOrders.totals
    .map((row) => formatCurrency(row.amount, row.currency))
    .join(' · ')

  const overview = [
    {
      label: '本月订单',
      value: monthOrders.count,
      hint: monthAmounts || '本月还没有订单',
      href: monthHref,
      icon: CalendarClock,
    },
    { label: '产品数', value: stats.productCount, hint: '在售与历史产品', icon: Package },
    { label: '客户数', value: stats.customerCount, hint: '合作客户总数', icon: Users },
    {
      label: 'PI 总数',
      value: stats.piCount,
      hint: `本月新增 ${stats.monthPiCount} 张`,
      icon: FileText,
    },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">工作台</h1>
          <p className="mt-1 text-sm text-muted-foreground">按你的角色汇总需要处理的事项</p>
        </div>
        <Button asChild>
          <Link href="/pi/create">
            <FilePlus2 className="h-4 w-4" />
            开具 PI
          </Link>
        </Button>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">待办</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <TodoCardView todo={leadTodo} />
          {financeAccess.costs && (
            <Suspense
              fallback={
                <>
                  <TodoCardSkeleton />
                  <TodoCardSkeleton />
                </>
              }
            >
              <CostTodoCards />
            </Suspense>
          )}
          {tailTodos.map((todo) => (
            <TodoCardView key={todo.key} todo={todo} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">概况</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {overview.map((item) => {
            const Icon = item.icon
            const body = (
              <Card
                className={`h-full ${item.href ? 'transition-colors hover:border-primary/40' : ''}`}
              >
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {item.label}
                  </CardTitle>
                  <Icon className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold tabular-nums">{item.value}</div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{item.hint}</p>
                </CardContent>
              </Card>
            )
            return item.href ? (
              <Link key={item.label} href={item.href} className="block">
                {body}
              </Link>
            ) : (
              <div key={item.label}>{body}</div>
            )
          })}
        </div>
      </section>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">最近 PI</CardTitle>
          <Button asChild variant="ghost" size="sm">
            <Link href="/pi/history">
              查看全部
              <ChevronRight className="h-4 w-4" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              还没有 PI，点击右上角开具第一张
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PI 编号</TableHead>
                  <TableHead>客户</TableHead>
                  <TableHead className="text-right">金额</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>日期</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((pi) => (
                  <TableRow key={pi.id}>
                    <TableCell>
                      <Link href={`/pi/${pi.id}`} className="font-medium hover:underline">
                        {pi.pi_number}
                      </Link>
                    </TableCell>
                    <TableCell>{pi.customer_snapshot?.name ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(pi.total, pi.currency)}
                    </TableCell>
                    <TableCell>
                      {pi.status === 'void' ? (
                        <Badge variant="destructive">已作废</Badge>
                      ) : (
                        <Badge variant="success">有效</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(pi.created_at)}
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
