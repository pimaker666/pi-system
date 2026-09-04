'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Eye, Plus, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
  BUSINESS_ORDER_STATUS_LABELS,
  BUSINESS_ORDER_STATUS_VARIANTS,
  getBusinessOrderCustomerName,
} from '@/lib/business-orders'
import { formatCny } from '@/lib/finance'
import { formatCurrency, formatDate, displayProfileName } from '@/lib/utils'
import type { BusinessOrder, BusinessOrderStatus, Profile } from '@/types'

export interface BusinessOrderListRow extends BusinessOrder {
  business_order_payments: Array<{ amount: number; voided_at: string | null }>
}

export interface PerformanceManagerProps {
  profile: Pick<Profile, 'id' | 'role'>
  orders: BusinessOrderListRow[]
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

  return (
    <div className="space-y-4">
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

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>订单 / 客户</TableHead>
              <TableHead>日期</TableHead>
              <TableHead>属性</TableHead>
              <TableHead>业务员</TableHead>
              <TableHead className="text-right">订单金额</TableHead>
              <TableHead className="text-right">已收款</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredOrders.map((order) => {
              const received = order.business_order_payments
                .filter((payment) => !payment.voided_at)
                .reduce((sum, payment) => sum + Number(payment.amount), 0)
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
                  <TableCell className="whitespace-nowrap">{formatDate(order.order_date)}</TableCell>
                  <TableCell>{BUSINESS_FULFILLMENT_LABELS[order.fulfillment_type]}</TableCell>
                  <TableCell>{displayProfileName(order.salesperson, order.salesperson_name_snapshot)}</TableCell>
                  <TableCell className="whitespace-nowrap text-right font-medium">
                    <div>{formatCurrency(Number(order.total_amount), order.currency)}</div>
                    <div className="text-xs font-normal text-muted-foreground">
                      {formatCny(Number(order.total_cny))}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    {formatCurrency(received, order.currency)}
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
                <TableCell colSpan={8} className="py-12 text-center text-muted-foreground">
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
