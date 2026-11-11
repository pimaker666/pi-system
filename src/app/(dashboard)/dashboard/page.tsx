import { Suspense } from 'react'
import Link from 'next/link'
import {
  BadgeDollarSign,
  Calculator,
  CalendarClock,
  ChevronRight,
  ClipboardCheck,
  FilePlus2,
  PackagePlus,
  ReceiptText,
  UserRound,
  Wallet,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getFinancePageAccess, requireApproved } from '@/lib/auth'
import { getDashboardStats } from '@/lib/dashboard-stats'
import {
  currentMonthDateRange,
  fetchDashboardMonthOrders,
  fetchDashboardPendingCommissionCount,
  fetchDashboardReceivables,
} from '@/lib/dashboard-todos-server'
import { getApprovalTodoCounts } from '@/lib/approvals-server'
import { fetchBusinessOrderCostTodoSummary } from '@/lib/business-order-costs-server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  RecentActivityTabs,
  type RecentOrderItem,
  type RecentPiItem,
} from '@/components/dashboard/recent-activity'
import { displayProfileName, formatCurrency } from '@/lib/utils'
import type { BusinessOrderStatus, CustomerSnapshot, UserRole } from '@/types'

const ROLE_LABELS: Record<UserRole, string> = {
  admin: '管理员',
  finance: '财务',
  supervisor: '业务主管',
  sales: '业务员',
}

interface TodoRowData {
  key: string
  label: string
  hint: string
  value: number
  unit: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  tone: 'danger' | 'warn' | 'info' | 'neutral'
  alert?: boolean
}

function TodoRow({ todo }: { todo: TodoRowData }) {
  const Icon = todo.icon
  const toneClass = {
    danger: 'bg-red-50 text-red-600',
    warn: 'bg-amber-50 text-amber-600',
    info: 'bg-blue-50 text-blue-600',
    neutral: 'bg-muted text-muted-foreground',
  }[todo.tone]
  return (
    <Link
      href={todo.href}
      className="flex items-center gap-3 border-b px-4 py-3.5 transition-colors last:border-b-0 hover:bg-accent/40"
    >
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${toneClass}`}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{todo.label}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={todo.hint}>
          {todo.hint}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p
          className={`text-lg font-semibold tabular-nums ${
            todo.alert ? 'text-destructive' : ''
          }`}
        >
          {todo.value}
          <span className="ml-0.5 text-xs font-normal text-muted-foreground">{todo.unit}</span>
        </p>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </Link>
  )
}

function TodoRowSkeleton() {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-3.5 last:border-b-0">
      <div className="h-10 w-10 shrink-0 animate-pulse rounded-lg bg-muted" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-3 w-20 animate-pulse rounded bg-muted" />
        <div className="h-3 w-40 animate-pulse rounded bg-muted" />
      </div>
      <div className="h-5 w-10 animate-pulse rounded bg-muted" />
    </div>
  )
}

/** 成本与结算按产品行全量判定，单独流式加载，避免拖慢工作台首屏。 */
async function CostTodoRows() {
  const supabase = await createClient()
  const profile = await requireApproved()
  let summary
  try {
    summary = await fetchBusinessOrderCostTodoSummary(supabase, profile.id)
  } catch {
    return null
  }

  const todos: TodoRowData[] = [
    {
      key: 'missing-cost',
      label: '待填成本',
      hint:
        summary.missingCostRowCount > 0
          ? `${summary.missingCostOrderCount} 笔订单 · ${summary.missingCostRowCount} 个产品行缺少成本，影响毛利与提成`
          : '可结算成本已全部填写',
      value: summary.missingCostRowCount,
      unit: '行',
      href: '/finance/costs',
      icon: Calculator,
      tone: summary.missingCostRowCount > 0 ? 'danger' : 'neutral',
      alert: summary.missingCostRowCount > 0,
    },
    {
      key: 'settlement',
      label: '待结算',
      hint:
        summary.pendingRowCount > 0
          ? `${summary.pendingOrderCount} 笔订单 · ${summary.pendingRowCount} 个产品行可结算`
          : '暂无可结算产品行',
      value: summary.pendingRowCount,
      unit: '行',
      href: '/finance/costs',
      icon: ReceiptText,
      tone: summary.pendingRowCount > 0 ? 'info' : 'neutral',
    },
  ]

  return (
    <>
      {todos.map((todo) => (
        <TodoRow key={todo.key} todo={todo} />
      ))}
    </>
  )
}

function greetingForHour(hour: number) {
  if (hour < 6) return '凌晨好'
  if (hour < 12) return '上午好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

interface RawBusinessOrder {
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

interface RawPi {
  id: string
  pi_number: string
  customer_snapshot: CustomerSnapshot | null
  currency: string
  total: number
  status: 'active' | 'void'
  created_at: string
}

export default async function DashboardPage() {
  const profile = await requireApproved()
  const supabase = await createClient()
  const financeAccess = await getFinancePageAccess()
  const isSalesperson = profile.role === 'sales' || profile.role === 'supervisor'
  const monthRange = currentMonthDateRange()

  const [stats, pisResult, approvals, receivables, monthOrders, commissionPending, ordersResult] =
    await Promise.all([
      getDashboardStats(),
      supabase
        .from('proforma_invoices')
        .select('id, pi_number, customer_snapshot, currency, total, status, created_at')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(8),
      getApprovalTodoCounts(),
      fetchDashboardReceivables(supabase),
      fetchDashboardMonthOrders(supabase),
      isSalesperson ? fetchDashboardPendingCommissionCount(supabase) : Promise.resolve(0),
      supabase
        .from('business_orders')
        .select(
          'id, order_number, status, order_date, customer_snapshot, salesperson_name_snapshot, salesperson_display_name_snapshot, currency, total_amount, total_cny, salesperson:profiles!salesperson_id(id, chinese_name, full_name, email)',
        )
        .is('voided_at', null)
        .order('order_date', { ascending: false })
        .limit(8),
    ])

  const recentPis: RecentPiItem[] = ((pisResult.data ?? []) as unknown as RawPi[]).map((pi) => {
    const customerLabel = pi.customer_snapshot?.company || pi.customer_snapshot?.name || ''
    return {
      id: pi.id,
      reference: pi.pi_number,
      customer: customerLabel || '客户待补',
      customerMissing: !customerLabel,
      currency: pi.currency,
      total: Number(pi.total),
      createdAt: pi.created_at,
      voided: pi.status === 'void',
    }
  })

  const recentOrders: RecentOrderItem[] = (
    (ordersResult.data ?? []) as unknown as RawBusinessOrder[]
  ).map((order) => {
    const customerLabel =
      order.customer_snapshot?.company || order.customer_snapshot?.name || ''
    return {
      id: order.id,
      reference: order.order_number,
      customer: customerLabel || '客户待补',
      customerMissing: !customerLabel,
      salesperson: displayProfileName(
        order.salesperson,
        order.salesperson_display_name_snapshot ?? order.salesperson_name_snapshot,
      ),
      currency: order.currency,
      originalAmount: Number(order.total_amount),
      amountCny: order.total_cny === null ? null : Number(order.total_cny),
      status: order.status,
      orderDate: order.order_date,
    }
  })

  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date()),
  )
  const dateLabel = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date())
  const displayName =
    profile.chinese_name || profile.full_name || profile.email.split('@')[0] || '你好'
  const monthLabel = `${monthRange.dateFrom.slice(0, 4)} 年 ${Number(monthRange.dateFrom.slice(5, 7))} 月`

  const ordersHref = (params: Record<string, string>) =>
    `/finance/daily-orders?${new URLSearchParams(params).toString()}`

  const receivableHint = [
    ...receivables.totals.map((row) => formatCurrency(row.amount, row.currency)),
    receivables.overdueCount > 0 ? `其中逾期 ${receivables.overdueCount} 单` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const approvalHint = [
    approvals.reimbursement > 0 ? `报销 ${approvals.reimbursement}` : null,
    approvals.leave > 0 ? `请假 ${approvals.leave}` : null,
    approvals.engine > 0 ? `审批申请 ${approvals.engine}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const tailTodos: TodoRowData[] = [
    {
      key: 'receivables',
      label: '未收尾款',
      hint: receivableHint || '所有订单已收齐',
      value: receivables.orderCount,
      unit: '单',
      href: ordersHref({ balanceStatuses: 'unsettled', settlementStatuses: 'all' }),
      icon: Wallet,
      tone: receivables.overdueCount > 0 ? 'warn' : 'neutral',
      alert: receivables.overdueCount > 0,
    },
    {
      key: 'approvals',
      label: '待我审批',
      hint: approvals.total > 0 ? approvalHint : '暂无待审批事项',
      value: approvals.total,
      unit: '项',
      href: '/approvals',
      icon: ClipboardCheck,
      tone: approvals.total > 0 ? 'info' : 'neutral',
    },
  ]
  if (isSalesperson) {
    tailTodos.push({
      key: 'commission',
      label: '待确认提成',
      hint: commissionPending > 0 ? '有提成待确认' : '提成已全部确认',
      value: commissionPending,
      unit: '行',
      href: '/finance/commission',
      icon: BadgeDollarSign,
      tone: 'neutral',
    })
  }

  const monthAmounts = monthOrders.totals
    .map((row) => formatCurrency(row.amount, row.currency))
    .join(' · ')

  const quickLinks = [
    { href: '/pi/create', label: '开具 PI', icon: FilePlus2, primary: true },
    { href: '/finance/daily-orders/new', label: '新建订单', icon: PackagePlus },
    { href: '/reimbursement', label: '费用报销', icon: ReceiptText },
    { href: '/finance/leave', label: '请假申请', icon: CalendarClock },
    { href: '/approvals', label: '审批中心', icon: ClipboardCheck },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {greetingForHour(hour)}，{displayName}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {dateLabel} · {ROLE_LABELS[profile.role] ?? profile.role} · 以下是你需要处理的事项与本月概览
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline">
            <Link href="/finance/daily-orders/new">
              <PackagePlus className="h-4 w-4" />
              新建订单
            </Link>
          </Button>
          <Button asChild>
            <Link href="/pi/create">
              <FilePlus2 className="h-4 w-4" />
              开具 PI
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">待办</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">按紧急程度排序，点击进入对应处理页</p>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {financeAccess.costs ? (
              <Suspense
                fallback={
                  <>
                    <TodoRowSkeleton />
                    <TodoRowSkeleton />
                  </>
                }
              >
                <CostTodoRows />
              </Suspense>
            ) : null}
            {tailTodos.map((todo) => (
              <TodoRow key={todo.key} todo={todo} />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-wrap items-start justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="text-base">本月速览</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">{monthLabel}</p>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link
                href={ordersHref({
                  dateFrom: monthRange.dateFrom,
                  dateTo: monthRange.dateTo,
                  settlementStatuses: 'all',
                })}
              >
                订单明细
                <ChevronRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 rounded-lg border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">本月订单</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {monthOrders.count}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">笔</span>
                </p>
                <p className="mt-1 truncate text-xs text-muted-foreground" title={monthAmounts}>
                  {monthAmounts || '本月还没有订单'}
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">本月新增 PI</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">
                  {stats.monthPiCount}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">张</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">PI 累计 {stats.piCount} 张</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">产品 / 客户</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">
                  {stats.productCount}
                  <span className="text-muted-foreground"> / </span>
                  {stats.customerCount}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">在售与历史产品</p>
              </div>
            </div>

            <div>
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <UserRound className="h-3.5 w-3.5" />
                快捷入口
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {quickLinks.map((entry) => {
                  const Icon = entry.icon
                  return (
                    <Button
                      key={entry.href}
                      asChild
                      size="sm"
                      variant={entry.primary ? 'default' : 'outline'}
                      className="justify-start"
                    >
                      <Link href={entry.href}>
                        <Icon className="h-4 w-4" />
                        {entry.label}
                      </Link>
                    </Button>
                  )
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <RecentActivityTabs orders={recentOrders} pis={recentPis} />
    </div>
  )
}
