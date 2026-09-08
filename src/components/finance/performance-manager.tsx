'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Eye, Plus, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  BUSINESS_FULFILLMENT_LABELS,
  BUSINESS_FULFILLMENT_STATUS_LABELS,
  BUSINESS_FULFILLMENT_STATUS_VARIANTS,
  BUSINESS_ORDER_STATUS_LABELS,
  BUSINESS_ORDER_STATUS_VARIANTS,
  BUSINESS_PAYMENT_STATUS_LABELS,
  BUSINESS_PAYMENT_STATUS_VARIANTS,
  getBusinessOrderCustomerName,
  getBusinessOverdueDays,
} from '@/lib/business-orders'
import { formatCny } from '@/lib/finance'
import { displayProfileName, formatCurrency, formatDate } from '@/lib/utils'
import type { BusinessOrder, BusinessOrderStatus, Profile } from '@/types'

interface AllocationListRow {
  amount: number
  voided_at: string | null
  transfer: {
    voided_at: string | null
    exchange_rate_to_cny: number
  } | null
}

export interface BusinessOrderListRow extends BusinessOrder {
  business_order_payment_allocations: AllocationListRow[]
}

export interface PerformanceManagerProps {
  profile: Pick<Profile, 'id' | 'role'>
  orders: BusinessOrderListRow[]
}

function effectiveAllocations(order: BusinessOrderListRow) {
  return order.business_order_payment_allocations.filter(
    (allocation) => !allocation.voided_at && allocation.transfer && !allocation.transfer.voided_at,
  )
}

export function PerformanceManager({ profile, orders }: PerformanceManagerProps) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | BusinessOrderStatus>('all')

  const filteredOrders = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    return orders.filter((order) => {
      if (status !== 'all' && order.status !== status) return false
      if (!normalized) return true
      const customer = getBusinessOrderCustomerName(order.customer_snapshot)
      return [
        order.order_number,
        customer,
        displayProfileName(order.salesperson, order.salesperson_name_snapshot),
      ]
        .join(' ')
        .toLocaleLowerCase('zh-CN')
        .includes(normalized)
    })
  }, [orders, query, status])

  const summary = useMemo(
    () =>
      filteredOrders.reduce(
        (result, order) => {
          const activeAllocations = effectiveAllocations(order)
          const received = activeAllocations.reduce(
            (sum, allocation) => sum + Number(allocation.amount),
            0,
          )
          const receivedCny = activeAllocations.reduce(
            (sum, allocation) =>
              sum + Number(allocation.amount) * Number(allocation.transfer?.exchange_rate_to_cny ?? 0),
            0,
          )
          result.orderTotalCny += Number(order.total_cny)
          result.receivedCny += receivedCny
          result.outstandingCny +=
            Math.max(Number(order.total_amount) - received, 0) * Number(order.exchange_rate_to_cny)
          if (getBusinessOverdueDays(order.payment_due_date, order.payment_status === 'fully_paid') > 0) {
            result.overdueCount += 1
          }
          return result
        },
        { orderTotalCny: 0, receivedCny: 0, outstandingCny: 0, overdueCount: 0 },
      ),
    [filteredOrders],
  )

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">筛选订单</div><div className="mt-1 text-xl font-semibold">{filteredOrders.length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">订单总额</div><div className="mt-1 text-xl font-semibold tabular-nums">{formatCny(summary.orderTotalCny)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">有效分摊已收</div><div className="mt-1 text-xl font-semibold tabular-nums text-green-700">{formatCny(summary.receivedCny)}</div></CardContent></Card>
        <Card className={summary.overdueCount > 0 ? 'border-destructive/40' : undefined}><CardContent className="p-4"><div className="text-xs text-muted-foreground">未收 / 逾期订单</div><div className="mt-1 text-xl font-semibold tabular-nums">{formatCny(summary.outstandingCny)} <span className={summary.overdueCount > 0 ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>/ {summary.overdueCount} 单</span></div></CardContent></Card>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row">
          <div className="relative max-w-md flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索订单号、客户或业务员"
              className="pl-9"
            />
          </div>
          <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              {Object.entries(BUSINESS_ORDER_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {(profile.role === 'sales' || profile.role === 'supervisor') && (
          <Button asChild>
            <Link href="/finance/performance/new">
              <Plus className="h-4 w-4" />
              新建业务订单
            </Link>
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border">
        <Table className="min-w-[1120px]">
          <TableHeader>
            <TableRow>
              <TableHead>订单 / 客户</TableHead>
              <TableHead>日期</TableHead>
              <TableHead>属性</TableHead>
              <TableHead>业务员</TableHead>
              <TableHead className="text-right">订单金额</TableHead>
              <TableHead className="text-right">已收 / 未收</TableHead>
              <TableHead>付款 / 发货</TableHead>
              <TableHead>流程状态</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredOrders.map((order) => {
              const received = effectiveAllocations(order).reduce(
                (sum, allocation) => sum + Number(allocation.amount),
                0,
              )
              const outstanding = Math.max(Number(order.total_amount) - received, 0)
              const daysOverdue = getBusinessOverdueDays(
                order.payment_due_date,
                order.payment_status === 'fully_paid',
              )
              const isLegacyCompleted =
                order.status === 'completed' && order.completion_gate_version < 2
              return (
                <TableRow key={order.id}>
                  <TableCell>
                    <Link
                      href={`/finance/performance/${order.id}`}
                      className="font-medium hover:underline"
                    >
                      {order.order_number}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {getBusinessOrderCustomerName(order.customer_snapshot)}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div>{formatDate(order.order_date)}</div>
                    {order.payment_due_date && (
                      <div className="text-xs text-muted-foreground">尾款 {formatDate(order.payment_due_date)}</div>
                    )}
                    {daysOverdue > 0 && <Badge variant="destructive" className="mt-1">逾期 {daysOverdue} 天</Badge>}
                  </TableCell>
                  <TableCell>{BUSINESS_FULFILLMENT_LABELS[order.fulfillment_type]}</TableCell>
                  <TableCell>{displayProfileName(order.salesperson, order.salesperson_name_snapshot)}</TableCell>
                  <TableCell className="whitespace-nowrap text-right font-medium">
                    <div>{formatCurrency(Number(order.total_amount), order.currency)}</div>
                    <div className="text-xs font-normal text-muted-foreground">
                      {formatCny(Number(order.total_cny))}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    <div className="text-green-700">{formatCurrency(received, order.currency)}</div>
                    <div className={outstanding > 0.005 ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                      未收 {formatCurrency(outstanding, order.currency)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <Badge variant={BUSINESS_PAYMENT_STATUS_VARIANTS[order.payment_status]}>
                        {BUSINESS_PAYMENT_STATUS_LABELS[order.payment_status]}
                      </Badge>
                      <Badge
                        variant={
                          isLegacyCompleted
                            ? 'secondary'
                            : BUSINESS_FULFILLMENT_STATUS_VARIANTS[order.fulfillment_status]
                        }
                      >
                        {isLegacyCompleted
                          ? '历史完成·发货未追溯'
                          : BUSINESS_FULFILLMENT_STATUS_LABELS[order.fulfillment_status]}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={BUSINESS_ORDER_STATUS_VARIANTS[order.status]}>
                      {BUSINESS_ORDER_STATUS_LABELS[order.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button asChild variant="ghost" size="icon">
                      <Link href={`/finance/performance/${order.id}`} aria-label="查看订单">
                        <Eye className="h-4 w-4" />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
            {filteredOrders.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-12 text-center text-muted-foreground">
                  暂无符合条件的业务订单
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
