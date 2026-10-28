'use client'

import Link from 'next/link'
import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatCny } from '@/lib/finance'
import { formatAmount } from '@/lib/utils'

export interface CustomerOrderLine {
  id: string
  order_id: string
  name_snapshot: string
  quantity: number
  unit_price: number
  sales_total_amount: number | null
  line_amount: number
  logistics_fee_amount: number | null
  sort_order: number
}

export interface CustomerOrderRow {
  id: string
  order_number: string
  external_order_number: string | null
  order_date: string
  currency: string
  total_amount: number
  shipping_fee: number
  status: string
  items: CustomerOrderLine[]
}

function formatMoney(amount: number, currency: string) {
  return currency === 'CNY'
    ? formatCny(amount)
    : `${currency} ${formatAmount(amount)}`
}

export function CustomerOrdersTable({ orders, fromCustomerId }: { orders: CustomerOrderRow[]; fromCustomerId: string }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const toggle = (orderId: string) =>
    setExpanded((prev) => ({ ...prev, [orderId]: !prev[orderId] }))

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10" />
          <TableHead>下单日期</TableHead>
          <TableHead>订单号</TableHead>
          <TableHead>平台订单号</TableHead>
          <TableHead>状态</TableHead>
          <TableHead className="text-right">订单金额</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => {
          const isOpen = !!expanded[order.id]
          return [
            <TableRow key={order.id}>
              <TableCell>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={isOpen ? `收起订单 ${order.order_number}` : `展开订单 ${order.order_number}`}
                  aria-expanded={isOpen}
                  onClick={() => toggle(order.id)}
                >
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
              </TableCell>
              <TableCell>{order.order_date}</TableCell>
              <TableCell>
                <Link
                  className="font-medium hover:underline"
                  href={`/finance/daily-orders/${order.id}?fromCustomer=${fromCustomerId}`}
                  target="_blank"
                >
                  {order.order_number}
                </Link>
              </TableCell>
              <TableCell>{order.external_order_number || '—'}</TableCell>
              <TableCell>{order.status}</TableCell>
              <TableCell className="text-right tabular-nums">{formatMoney(order.total_amount, order.currency)}</TableCell>
            </TableRow>,
            isOpen ? (
              <TableRow key={`${order.id}-detail`}>
                <TableCell colSpan={6} className="bg-muted/30 p-3">
                  <div className="overflow-x-auto rounded-md border bg-background">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>产品</TableHead>
                          <TableHead className="text-right">数量</TableHead>
                          <TableHead className="text-right">单价</TableHead>
                          <TableHead className="text-right">销售额</TableHead>
                          <TableHead className="text-right">运费</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {order.items.map((item) => (
                          <TableRow key={item.id}>
                            <TableCell>{item.name_snapshot}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatAmount(item.quantity)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatMoney(item.unit_price, order.currency)}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatMoney(item.sales_total_amount ?? item.line_amount, order.currency)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {item.logistics_fee_amount !== null ? formatMoney(item.logistics_fee_amount, order.currency) : '—'}
                            </TableCell>
                          </TableRow>
                        ))}
                        {order.items.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">暂无产品明细</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="mt-2 text-right text-sm text-muted-foreground tabular-nums">
                    订单运费 {formatMoney(order.shipping_fee, order.currency)} · 订单总金额 {formatMoney(order.total_amount, order.currency)}
                  </p>
                </TableCell>
              </TableRow>
            ) : null,
          ]
        })}
        {orders.length === 0 && (
          <TableRow>
            <TableCell colSpan={6} className="py-12 text-center text-muted-foreground">暂无历史订单</TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
}
