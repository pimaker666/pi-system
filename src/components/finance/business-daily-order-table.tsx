'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Download, Eye, FileText, Pencil, Truck } from 'lucide-react'
import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { bulkShipBusinessOrders, getBusinessOrderAttachmentUrl } from '@/lib/actions/business-orders'
import {
  BUSINESS_ORDER_STATUS_LABELS,
  BUSINESS_ORDER_STATUS_VARIANTS,
  getBusinessOrderCustomerName,
} from '@/lib/business-orders'
import {
  activeBusinessOrderAttachments,
  businessDailyOrderTotals,
  canEditBusinessDailyOrder,
  formatMergedBusinessDailyShippingProgress,
  mergeBusinessDailyItems,
  type BusinessDailyLedgerOrder,
  type MergedBusinessDailyItem,
} from '@/lib/business-daily-orders'
import {
  businessOrderItemDisplayName,
  businessOrderItemDisplaySku,
} from '@/lib/business-order-financials'
import { DAILY_ORDER_COLUMNS, formatDailyMoney, PAYMENT_LABELS, SHIPPING_LABELS } from '@/lib/daily-orders'
import { displayProfileName } from '@/lib/utils'
import type { BusinessOrder, Profile } from '@/types'

const mergedCellClassName = 'bg-muted/20 align-top'

export interface BusinessDailyOrderTableProps {
  orders: BusinessDailyLedgerOrder[]
  actor: Pick<Profile, 'id' | 'role'>
  filterQuery?: string
  settledItemIds?: string[]
}

function canBulkShipOrder(order: BusinessOrder, actor: Pick<Profile, 'id' | 'role'>) {
  if (order.closed_at) return false
  if (order.status !== 'approved') return false
  if (actor.role === 'sales' && order.salesperson_id !== actor.id) return false
  return true
}

function toDateTimeLocalValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 恢复后的每日订单台账：表头字段跨明细行合并，产品字段逐行展示，
 * 列顺序与每日订单导出完全一致，数据来自 business_orders 单一事实源。
 */
export function BusinessDailyOrderTable({ orders, actor, filterQuery = '', settledItemIds = [] }: BusinessDailyOrderTableProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [bulkPending, startBulkTransition] = useTransition()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [shippedAt, setShippedAt] = useState(() => toDateTimeLocalValue(new Date()))

  const settledSet = useMemo(() => new Set(settledItemIds), [settledItemIds])
  const isMergedItemSettled = (item: MergedBusinessDailyItem) =>
    item.item_ids.length > 0 && item.item_ids.every((id) => settledSet.has(id))

  const groups = useMemo(
    () =>
      orders.map((order) => ({
        order,
        items: mergeBusinessDailyItems(order),
        attachments: activeBusinessOrderAttachments(order),
      })),
    [orders],
  )

  const selectableOrders = useMemo(
    () => orders.filter((order) => canBulkShipOrder(order, actor)),
    [orders, actor],
  )
  const selectableIds = useMemo(
    () => new Set(selectableOrders.map((order) => order.id)),
    [selectableOrders],
  )
  const selectedCount = useMemo(
    () => [...selectedIds].filter((id) => selectableIds.has(id)).length,
    [selectedIds, selectableIds],
  )
  const allSelected = selectableOrders.length > 0 && selectedCount === selectableOrders.length

  const exportUrl = useMemo(() => {
    const validSelectedIds = [...selectedIds].filter((id) => selectableIds.has(id))
    const base = filterQuery ? `?${filterQuery}` : '?'
    if (validSelectedIds.length > 0) {
      return base + '&' + validSelectedIds.map((id) => `ids=${id}`).join('&')
    }
    return base
  }, [selectedIds, selectableIds, filterQuery])

  function viewAttachment(attachmentId: string) {
    startTransition(async () => {
      const result = await getBusinessOrderAttachmentUrl(attachmentId)
      if (result.url) window.open(result.url, '_blank', 'noopener,noreferrer')
      else toast.error(result.error ?? '无法查看截图')
    })
  }

  function toggleOrderSelection(orderId: string, checked: boolean) {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (checked) next.add(orderId)
      else next.delete(orderId)
      return next
    })
  }

  function toggleSelectAll(checked: boolean) {
    if (checked) {
      setSelectedIds(new Set(selectableIds))
    } else {
      setSelectedIds(new Set())
    }
  }

  function bulkShipSelected() {
    const ids = [...selectedIds].filter((id) => selectableIds.has(id))
    if (ids.length === 0) {
      toast.error('请先勾选订单')
      return
    }
    startBulkTransition(async () => {
      const result = await bulkShipBusinessOrders(ids, new Date(shippedAt).toISOString())
      if (!result.ok) {
        toast.error(result.error ?? '整单发货失败')
        return
      }
      toast.success(
        `已发货 ${result.shippedCount ?? 0} 个订单${result.skippedCount ? `，跳过 ${result.skippedCount} 个无待发数量订单` : ''}`,
      )
      setSelectedIds(new Set())
      router.refresh()
    })
  }

  return (
    <div className="space-y-3">
      {orders.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
          {selectableOrders.length > 0 && (
            <>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>已选 {selectedCount} 个订单</span>
              </div>
              <Input
                type="datetime-local"
                value={shippedAt}
                onChange={(event) => setShippedAt(event.target.value)}
                disabled={bulkPending}
                className="w-auto"
              />
              <Button
                type="button"
                onClick={bulkShipSelected}
                disabled={selectedCount === 0 || bulkPending}
              >
                <Truck className="mr-1.5 h-4 w-4" />
                整单发货
              </Button>
            </>
          )}
          <div className={`${selectableOrders.length > 0 ? 'ml-auto' : ''} flex gap-2`}>
            <Button asChild variant="outline" size="sm">
              <a download href={`/api/finance/daily-orders/export/xlsx${exportUrl}`}>
                <Download className="h-4 w-4" />XLSX
              </a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/finance/daily-orders/export/pdf${exportUrl}`}>
                <FileText className="h-4 w-4" />PDF
              </a>
            </Button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-md border">
        <Table className="min-w-[2800px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">
                {selectableOrders.length > 0 && (
                  <input
                    type="checkbox"
                    aria-label="全选"
                    checked={allSelected}
                    onChange={(event) => toggleSelectAll(event.target.checked)}
                  />
                )}
              </TableHead>
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
              const canShip = canBulkShipOrder(order, actor)
              const isSelected = selectedIds.has(order.id)
              const salesperson = displayProfileName(
                order.salesperson,
                order.salesperson_display_name_snapshot ?? order.salesperson_name_snapshot,
              )
              const totals = businessDailyOrderTotals(order)

              return rows.map((item, rowIndex) => {
                const isFirstRow = rowIndex === 0

                return (
                  <TableRow
                    key={item ? item.id : order.id}
                    className={isFirstRow && groupIndex > 0 ? 'border-t-2' : undefined}
                  >
                    <TableCell className="align-top">
                      {isFirstRow && canShip && (
                        <input
                          type="checkbox"
                          aria-label={`选择订单 ${order.order_number}`}
                          checked={isSelected}
                          onChange={(event) => toggleOrderSelection(order.id, event.target.checked)}
                        />
                      )}
                    </TableCell>
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
                          <div className="mt-1 space-y-0.5 text-xs font-normal tabular-nums">
                            <div>应收 {formatDailyMoney(totals.receivable, order.currency)}</div>
                            <div>实收 {formatDailyMoney(totals.salesTotal, order.currency)}</div>
                            <div className={totals.difference === 0 ? 'text-muted-foreground' : 'text-amber-700'}>
                              差额 {formatDailyMoney(totals.difference, order.currency)}
                            </div>
                            {totals.difference !== 0 && order.receivable_received_difference_reason && (
                              <div className="max-w-48 whitespace-normal text-muted-foreground">
                                原因：{order.receivable_received_difference_reason}
                              </div>
                            )}
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
                          {order.daily_shipping_number || order.payment_account || '—'}
                        </TableCell>
                      </>
                    )}

                    <TableCell>
                      {item?.daily_shipping_category ? SHIPPING_LABELS[item.daily_shipping_category] : '—'}
                    </TableCell>
                    <TableCell>
                      <div>{item ? businessOrderItemDisplayName(item) : '—'}</div>
                      {item && businessOrderItemDisplaySku(item) && (
                        <div className="text-xs text-muted-foreground">
                          {businessOrderItemDisplaySku(item)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {item ? item.quantity.toLocaleString() : '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {item ? formatMergedBusinessDailyShippingProgress(item) : '—'}
                    </TableCell>
                    <TableCell>
                      {item ? formatDailyMoney(item.unit_price, order.currency) : '—'}
                    </TableCell>
                    <TableCell>
                      {item ? formatDailyMoney(item.product_received_amount, order.currency) : '—'}
                    </TableCell>
                    <TableCell>
                      {item && item.logistics_fee_amount !== null
                        ? formatDailyMoney(item.logistics_fee_amount, order.currency)
                        : '—'}
                    </TableCell>

                    {isFirstRow && (
                      <>
                        <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} font-medium`}>
                          {formatDailyMoney(Number(order.total_amount), order.currency)}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} font-medium`}>
                          {formatDailyMoney(order.outstanding_amount, order.currency)}
                        </TableCell>
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

                    <TableCell className="align-top">
                      {item ? (
                        isMergedItemSettled(item) ? (
                          <Badge variant="success">是</Badge>
                        ) : (
                          <span className="text-muted-foreground">否</span>
                        )
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                )
              })
            })}
            {orders.length === 0 && (
              <TableRow>
                <TableCell colSpan={DAILY_ORDER_COLUMNS.length + 1} className="py-12 text-center text-muted-foreground">
                  没有符合筛选条件的订单
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
