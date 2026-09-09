'use client'

import Link from 'next/link'
import { Eye, FileText, Pencil } from 'lucide-react'
import { useMemo, useTransition } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getBusinessOrderAttachmentUrl } from '@/lib/actions/business-orders'
import {
  BUSINESS_ORDER_STATUS_LABELS,
  BUSINESS_ORDER_STATUS_VARIANTS,
  getBusinessOrderCustomerName,
} from '@/lib/business-orders'
import {
  activeBusinessOrderAttachments,
  businessDailyItemAmounts,
  canEditBusinessDailyOrder,
  sortedBusinessDailyItems,
  type BusinessDailyLedgerOrder,
} from '@/lib/business-daily-orders'
import { DAILY_ORDER_COLUMNS, formatDailyMoney, PAYMENT_LABELS, SHIPPING_LABELS } from '@/lib/daily-orders'
import { displayProfileName } from '@/lib/utils'
import type { Profile } from '@/types'

const mergedCellClassName = 'bg-muted/20 align-top'

export interface BusinessDailyOrderTableProps {
  orders: BusinessDailyLedgerOrder[]
  actor: Pick<Profile, 'id' | 'role'>
}

/**
 * 恢复后的每日订单台账：表头字段跨明细行合并，产品字段逐行展示，
 * 列顺序与旧版 17 列完全一致，数据来自 business_orders 单一事实源。
 */
export function BusinessDailyOrderTable({ orders, actor }: BusinessDailyOrderTableProps) {
  const [pending, startTransition] = useTransition()
  const groups = useMemo(
    () =>
      orders.map((order) => ({
        order,
        items: sortedBusinessDailyItems(order),
        attachments: activeBusinessOrderAttachments(order),
      })),
    [orders],
  )

  function viewAttachment(attachmentId: string) {
    startTransition(async () => {
      const result = await getBusinessOrderAttachmentUrl(attachmentId)
      if (result.url) window.open(result.url, '_blank', 'noopener,noreferrer')
      else toast.error(result.error ?? '无法查看截图')
    })
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table className="min-w-[2450px]">
        <TableHeader>
          <TableRow>
            {DAILY_ORDER_COLUMNS.map((label) => (
              <TableHead key={label}>{label}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map(({ order, items, attachments }, groupIndex) => {
            // 历史业务订单没有明细时也要占一行，否则订单会在台账里凭空消失。
            const rows = items.length > 0 ? items : [null]
            const rowSpan = rows.length
            const canEdit = canEditBusinessDailyOrder(order, actor)
            const salesperson = displayProfileName(order.salesperson, order.salesperson_name_snapshot)

            return rows.map((item, rowIndex) => {
              const isFirstRow = rowIndex === 0
              const amounts = item ? businessDailyItemAmounts(item) : null

              return (
                <TableRow
                  key={item ? item.id : order.id}
                  className={isFirstRow && groupIndex > 0 ? 'border-t-2' : undefined}
                >
                  <TableCell>
                    <div className="font-medium">
                      {groupIndex + 1}
                      {rowSpan > 1 && (
                        <span className="ml-1 text-xs text-muted-foreground">-{rowIndex + 1}</span>
                      )}
                    </div>
                    {isFirstRow && (
                      <div className="flex">
                        <Button asChild variant="ghost" size="icon">
                          <Link
                            href={`/finance/daily-orders/${order.id}`}
                            aria-label={`查看 ${order.order_number}`}
                          >
                            <FileText className="h-3.5 w-3.5" />
                          </Link>
                        </Button>
                        {canEdit && (
                          <Button asChild variant="ghost" size="icon">
                            <Link
                              href={`/finance/daily-orders/${order.id}/edit`}
                              aria-label={`编辑 ${order.order_number}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Link>
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>

                  {isFirstRow && (
                    <>
                      <TableCell rowSpan={rowSpan} className={mergedCellClassName}>
                        {order.order_date}
                      </TableCell>
                      <TableCell rowSpan={rowSpan} className={mergedCellClassName}>
                        <div>{order.shop_name_snapshot ?? '—'}</div>
                        {order.shop_group_name_snapshot && (
                          <div className="text-xs text-muted-foreground">
                            {order.shop_group_name_snapshot}
                          </div>
                        )}
                      </TableCell>
                      <TableCell rowSpan={rowSpan} className={mergedCellClassName}>
                        {salesperson}
                      </TableCell>
                      <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} font-medium`}>
                        <Link href={`/finance/daily-orders/${order.id}`} className="hover:underline">
                          {order.external_order_number || order.order_number}
                        </Link>
                        {order.external_order_number && (
                          <div className="text-xs font-normal text-muted-foreground">
                            {order.order_number}
                          </div>
                        )}
                        <div className="text-xs font-normal text-muted-foreground">
                          {getBusinessOrderCustomerName(order.customer_snapshot)}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {order.closed_at ? (
                            <Badge variant="secondary">特殊关闭</Badge>
                          ) : (
                            <Badge variant={BUSINESS_ORDER_STATUS_VARIANTS[order.status]}>
                              {BUSINESS_ORDER_STATUS_LABELS[order.status]}
                            </Badge>
                          )}
                          {rowSpan > 1 && (
                            <span className="text-xs font-normal text-muted-foreground">
                              {rowSpan} 个产品
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell rowSpan={rowSpan} className={mergedCellClassName}>
                        {order.daily_shipping_date ?? '—'}
                      </TableCell>
                      <TableCell rowSpan={rowSpan} className={mergedCellClassName}>
                        {order.daily_shipping_number || order.tracking_number || '—'}
                      </TableCell>
                    </>
                  )}

                  <TableCell>
                    {item?.daily_shipping_category ? SHIPPING_LABELS[item.daily_shipping_category] : '—'}
                  </TableCell>
                  <TableCell>
                    <div>{item?.name_snapshot ?? '—'}</div>
                    {item?.sku_snapshot && (
                      <div className="text-xs text-muted-foreground">{item.sku_snapshot}</div>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {item ? Number(item.quantity).toLocaleString() : '—'}
                  </TableCell>
                  <TableCell>
                    {amounts ? formatDailyMoney(amounts.unitPrice, order.currency) : '—'}
                  </TableCell>
                  <TableCell>
                    {amounts ? formatDailyMoney(amounts.productReceived, order.currency) : '—'}
                  </TableCell>
                  <TableCell>
                    {amounts && amounts.logisticsFee !== null
                      ? formatDailyMoney(amounts.logisticsFee, order.currency)
                      : '—'}
                  </TableCell>
                  <TableCell className="font-medium">
                    {amounts ? formatDailyMoney(amounts.salesTotal, order.currency) : '—'}
                  </TableCell>

                  {isFirstRow && (
                    <>
                      <TableCell rowSpan={rowSpan} className={mergedCellClassName}>
                        {order.daily_payment_category
                          ? PAYMENT_LABELS[order.daily_payment_category]
                          : '—'}
                      </TableCell>
                      <TableCell
                        rowSpan={rowSpan}
                        className={`${mergedCellClassName} max-w-64 whitespace-normal`}
                      >
                        {order.sales_notes || '—'}
                      </TableCell>
                      <TableCell rowSpan={rowSpan} className={mergedCellClassName}>
                        {attachments.length === 0
                          ? '—'
                          : attachments.map((attachment, attachmentIndex) => (
                              <Button
                                key={attachment.id}
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={pending}
                                onClick={() => viewAttachment(attachment.id)}
                              >
                                {attachmentIndex + 1}
                                <Eye className="ml-1 h-3 w-3" />
                              </Button>
                            ))}
                      </TableCell>
                    </>
                  )}
                </TableRow>
              )
            })
          })}
          {orders.length === 0 && (
            <TableRow>
              <TableCell colSpan={DAILY_ORDER_COLUMNS.length} className="py-12 text-center text-muted-foreground">
                没有符合筛选条件的订单
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
