'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { BUSINESS_ORDER_STATUS_LABELS, BUSINESS_ORDER_STATUS_VARIANTS } from '@/lib/business-orders'
import { formatCny } from '@/lib/finance'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { BusinessOrderStatus } from '@/types'

export interface RecentPiItem {
  id: string
  reference: string
  customer: string
  customerMissing: boolean
  currency: string
  total: number
  createdAt: string
  voided: boolean
}

export interface RecentOrderItem {
  id: string
  reference: string
  customer: string
  customerMissing: boolean
  salesperson: string
  currency: string
  originalAmount: number
  amountCny: number | null
  status: BusinessOrderStatus
  orderDate: string
}

type TabKey = 'orders' | 'pi'

const TABS: { key: TabKey; label: string; href: string; empty: string }[] = [
  { key: 'orders', label: '最近订单', href: '/finance/daily-orders', empty: '还没有业务订单' },
  { key: 'pi', label: '最近 PI', href: '/pi/history', empty: '还没有 PI' },
]

export function RecentActivityTabs({
  orders,
  pis,
}: {
  orders: RecentOrderItem[]
  pis: RecentPiItem[]
}) {
  const [tab, setTab] = useState<TabKey>('orders')
  const active = TABS.find((item) => item.key === tab) ?? TABS[0]

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">最近动态</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">PI 与订单统一时间线，点击直达单据</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border bg-muted/40 p-0.5">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={`rounded-md px-3 py-1 text-sm transition-colors ${
                  item.key === tab
                    ? 'bg-background font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                aria-pressed={item.key === tab}
              >
                {item.label}
              </button>
            ))}
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link href={active.href}>
              查看全部
              <ChevronRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {tab === 'orders' ? (
          orders.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{active.empty}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>订单号</TableHead>
                  <TableHead>客户</TableHead>
                  <TableHead>业务员</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">原币金额</TableHead>
                  <TableHead>日期</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell>
                      <Link
                        href={`/finance/daily-orders/${order.id}`}
                        className="font-medium hover:underline"
                      >
                        {order.reference}
                      </Link>
                    </TableCell>
                    <TableCell
                      className={order.customerMissing ? 'text-amber-600' : undefined}
                    >
                      {order.customer}
                    </TableCell>
                    <TableCell>{order.salesperson}</TableCell>
                    <TableCell>
                      <Badge variant={BUSINESS_ORDER_STATUS_VARIANTS[order.status]}>
                        {BUSINESS_ORDER_STATUS_LABELS[order.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(order.originalAmount, order.currency)}
                      {order.amountCny === null ? null : (
                        <span className="block text-xs text-muted-foreground">
                          {formatCny(order.amountCny)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(order.orderDate)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        ) : pis.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{active.empty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PI 编号</TableHead>
                <TableHead>客户</TableHead>
                <TableHead className="text-right">原币金额</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>日期</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pis.map((pi) => (
                <TableRow key={pi.id}>
                  <TableCell>
                    <Link href={`/pi/${pi.id}`} className="font-medium hover:underline">
                      {pi.reference}
                    </Link>
                  </TableCell>
                  <TableCell className={pi.customerMissing ? 'text-amber-600' : undefined}>
                    {pi.customer}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(pi.total, pi.currency)}
                  </TableCell>
                  <TableCell>
                    {pi.voided ? (
                      <Badge variant="destructive">已作废</Badge>
                    ) : (
                      <Badge variant="success">有效</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(pi.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
