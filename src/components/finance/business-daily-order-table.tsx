'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Download, Eye, FileText, Pencil, Truck, UserRoundPlus } from 'lucide-react'
import { useMemo, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { CustomerCombobox } from '@/components/customers/customer-combobox'
import { CountryFlag } from '@/components/shared/country-flag'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ImagePreview } from '@/components/ui/image-preview'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  bulkShipBusinessOrders,
  getBusinessOrderAttachmentUrl,
  setBusinessOrderCustomer,
} from '@/lib/actions/business-orders'
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
import { cn, displayProfileName } from '@/lib/utils'
import type { BusinessOrder, Customer, CustomerGroup, Profile } from '@/types'

const BUSINESS_DAILY_ORDER_COLUMNS = [
  ...DAILY_ORDER_COLUMNS.slice(0, 8),
  '产品图片',
  ...DAILY_ORDER_COLUMNS.slice(8),
]

export interface BusinessDailyOrderTableProps {
  orders: BusinessDailyLedgerOrder[]
  actor: Pick<Profile, 'id' | 'role'>
  customers: Customer[]
  customerGroups: CustomerGroup[]
  filterQuery?: string
  settledItemIds?: string[]
  confirmedCommissionItemIds?: string[]
}

function canBulkShipOrder(order: BusinessOrder, actor: Pick<Profile, 'id' | 'role'>) {
  if (!['admin', 'finance'].includes(actor.role)) return false
  if (order.closed_at || order.voided_at) return false
  return order.status === 'approved'
}

function canSetOrderCustomer(order: BusinessOrder, actor: Pick<Profile, 'id' | 'role'>) {
  if (order.voided_at) return false
  if (actor.role === 'admin' || actor.role === 'finance') return true
  return (actor.role === 'sales' || actor.role === 'supervisor') && order.salesperson_id === actor.id
}

function toDateTimeLocalValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 恢复后的每日订单台账：表头字段跨明细行合并，产品字段逐行展示，
 * 列顺序与每日订单导出完全一致，数据来自 business_orders 单一事实源。
 */
export function BusinessDailyOrderTable({
  orders,
  actor,
  customers,
  customerGroups,
  filterQuery = '',
  settledItemIds = [],
  confirmedCommissionItemIds = [],
}: BusinessDailyOrderTableProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [bulkPending, startBulkTransition] = useTransition()
  const [customerPending, startCustomerTransition] = useTransition()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [shippedAt, setShippedAt] = useState(() => toDateTimeLocalValue(new Date()))
  const [customerOrder, setCustomerOrder] = useState<BusinessDailyLedgerOrder | null>(null)
  const [customerDraft, setCustomerDraft] = useState<Customer | null>(null)
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  const [pinnedCol, setPinnedCol] = useState<number | null>(null)

  // 冻结用户点击「固定」时视口最左侧的那一列，而不是永远固定首列。
  function togglePin(checked: boolean) {
    if (!checked) {
      setPinnedCol(null)
      return
    }
    const table = tableRef.current
    const container = table?.parentElement
    const headerRow = table?.tHead?.rows[0]
    if (!table || !container || !headerRow) return
    const scrollLeft = container.scrollLeft
    let target = 0
    for (let i = 0; i < headerRow.cells.length; i += 1) {
      if ((headerRow.cells[i] as HTMLElement).offsetLeft <= scrollLeft + 1) target = i
      else break
    }
    setPinnedCol(target)
  }

  const headCn = (index: number, extra?: string) =>
    cn('sticky top-0 bg-background', extra, pinnedCol === index ? 'left-0 z-30' : 'z-20')
  const cellCn = (index: number, extra?: string) =>
    cn(extra, pinnedCol === index && 'sticky left-0 z-10 bg-background')
  const mergedCn = (index: number, extra?: string) =>
    cn('align-top', pinnedCol === index ? 'sticky left-0 z-10 bg-background' : 'bg-muted/20', extra)

  const settledSet = useMemo(() => new Set(settledItemIds), [settledItemIds])
  const isMergedItemSettled = (item: MergedBusinessDailyItem) =>
    item.item_ids.length > 0 && item.item_ids.every((id) => settledSet.has(id))

  const confirmedCommissionSet = useMemo(
    () => new Set(confirmedCommissionItemIds),
    [confirmedCommissionItemIds],
  )
  const isMergedItemCommissionCleared = (item: MergedBusinessDailyItem) =>
    item.item_ids.length > 0 && item.item_ids.every((id) => confirmedCommissionSet.has(id))

  const groups = useMemo(
    () =>
      orders.map((order) => ({
        order,
        items: mergeBusinessDailyItems(order),
        attachments: activeBusinessOrderAttachments(order),
      })),
    [orders],
  )

  const canManageShipments = actor.role === 'admin' || actor.role === 'finance'
  const shippableOrders = useMemo(
    () => orders.filter((order) => canBulkShipOrder(order, actor)),
    [orders, actor],
  )
  const selectableOrders = canManageShipments ? shippableOrders : orders
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
      if (result.url) setAttachmentUrl(result.url)
      else toast.error(result.error ?? '无法查看截图')
    })
  }

  function openCustomerDialog(order: BusinessDailyLedgerOrder) {
    setCustomerOrder(order)
    setCustomerDraft(customers.find((customer) => customer.id === order.customer_id) ?? null)
  }

  function saveCustomer(customer: Customer | null) {
    if (!customerOrder || customer === null && !customerOrder.customer_id) {
      toast.error('请选择客户')
      return
    }
    startCustomerTransition(async () => {
      const result = await setBusinessOrderCustomer({
        order_id: customerOrder.id,
        customer_id: customer?.id ?? null,
      })
      if (!result.ok) {
        toast.error(result.error ?? '设置订单客户失败')
        return
      }
      toast.success(customer ? '订单客户已同步' : '订单客户已取消绑定')
      setCustomerOrder(null)
      setCustomerDraft(null)
      router.refresh()
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
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>已选 {selectedCount} 个订单</span>
            </div>
          )}
          {canManageShipments && shippableOrders.length > 0 && (
            <>
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
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={pinnedCol !== null}
                onChange={(event) => togglePin(event.target.checked)}
              />
              固定当前列
            </label>
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

      <Table
        ref={tableRef}
        containerClassName="rounded-md border"
        className="min-w-[2800px]"
      >
        <TableHeader>
          <TableRow>
            <TableHead className={headCn(0, 'w-12')}>
              {selectableOrders.length > 0 && (
                <input
                  type="checkbox"
                  aria-label="全选"
                  checked={allSelected}
                  onChange={(event) => toggleSelectAll(event.target.checked)}
                />
              )}
            </TableHead>
            {BUSINESS_DAILY_ORDER_COLUMNS.map((label, index) => (
              <TableHead key={label} className={headCn(index + 1)}>
                {label}
              </TableHead>
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
              const canSelect = canManageShipments ? canShip : true
              const canSetCustomer = canSetOrderCustomer(order, actor)
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
                    <TableCell className={cellCn(0, 'align-top')}>
                      {isFirstRow && canSelect && (
                        <input
                          type="checkbox"
                          aria-label={`选择订单 ${order.order_number}`}
                          checked={isSelected}
                          onChange={(event) => toggleOrderSelection(order.id, event.target.checked)}
                        />
                      )}
                    </TableCell>
                    <TableCell className={cellCn(1)}>
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
                        <TableCell rowSpan={rowSpan} className={mergedCn(2)}>
                          {order.order_date}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={mergedCn(3)}>
                          <div>{order.shop_name_snapshot ?? '—'}</div>
                          {order.shop_group_name_snapshot && (
                            <div className="text-xs text-muted-foreground">
                              {order.shop_group_name_snapshot}
                            </div>
                          )}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={mergedCn(4)}>
                          {salesperson}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={mergedCn(5, 'font-medium')}>
                          <Link href={`/finance/daily-orders/${order.id}`} className="hover:underline">
                            {order.external_order_number || order.order_number}
                          </Link>
                          {order.external_order_number && (
                            <div className="text-xs font-normal text-muted-foreground">
                              {order.order_number}
                            </div>
                          )}
                          <div className="flex flex-wrap items-center gap-1 text-xs font-normal text-muted-foreground">
                            <CountryFlag country={order.current_customer_country ?? order.customer_snapshot?.country} />
                            <span
                              style={{
                                color:
                                  order.customer?.tag_color ??
                                  order.customer_snapshot?.tag_color ??
                                  undefined,
                              }}
                            >
                              {order.customer_id
                                ? getBusinessOrderCustomerName(order.customer_snapshot)
                                : '未绑定客户'}
                            </span>
                            {canSetCustomer && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 px-1.5 text-xs"
                                onClick={() => openCustomerDialog(order)}
                              >
                                <UserRoundPlus className="h-3.5 w-3.5" />
                                {order.customer_id ? '更换客户' : '绑定客户'}
                              </Button>
                            )}
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
                        <TableCell rowSpan={rowSpan} className={mergedCn(6)}>
                          {order.daily_shipping_date ?? '—'}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={mergedCn(7)}>
                          {order.daily_shipping_number || order.payment_account || '—'}
                        </TableCell>
                      </>
                    )}

                    <TableCell className={cellCn(8)}>
                      {item?.daily_shipping_category ? SHIPPING_LABELS[item.daily_shipping_category] : '—'}
                    </TableCell>
                    <TableCell className={cellCn(9)}>
                      {item ? (
                        <ImagePreview
                          src={item.image_url_snapshot}
                          alt={businessOrderItemDisplayName(item)}
                        />
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className={cellCn(10)}>
                      <div>{item ? businessOrderItemDisplayName(item) : '—'}</div>
                      {item && businessOrderItemDisplaySku(item) && (
                        <div className="text-xs text-muted-foreground">
                          {businessOrderItemDisplaySku(item)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className={cellCn(11, 'tabular-nums')}>
                      {item ? item.quantity.toLocaleString() : '—'}
                    </TableCell>
                    <TableCell className={cellCn(12, 'whitespace-nowrap tabular-nums')}>
                      {item ? formatMergedBusinessDailyShippingProgress(item) : '—'}
                    </TableCell>
                    <TableCell className={cellCn(13)}>
                      {item ? formatDailyMoney(item.unit_price, order.currency) : '—'}
                    </TableCell>
                    <TableCell className={cellCn(14)}>
                      {item ? formatDailyMoney(item.product_received_amount, order.currency) : '—'}
                    </TableCell>
                    <TableCell className={cellCn(15)}>
                      {item && item.logistics_fee_amount !== null
                        ? formatDailyMoney(item.logistics_fee_amount, order.currency)
                        : '—'}
                    </TableCell>

                    {isFirstRow && (
                      <>
                        <TableCell rowSpan={rowSpan} className={mergedCn(16, 'font-medium')}>
                          {formatDailyMoney(Number(order.total_amount), order.currency)}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={mergedCn(17, 'font-medium')}>
                          {formatDailyMoney(order.outstanding_amount, order.currency)}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={mergedCn(18)}>
                          {order.daily_payment_category
                            ? PAYMENT_LABELS[order.daily_payment_category]
                            : '—'}
                        </TableCell>
                        <TableCell
                          rowSpan={rowSpan}
                          className={mergedCn(19, 'max-w-64 whitespace-normal')}
                        >
                          {order.sales_notes || '—'}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={mergedCn(20)}>
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

                    <TableCell className={cellCn(21, 'align-top')}>
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
                    <TableCell className={cellCn(22, 'align-top')}>
                      {item ? (
                        isMergedItemCommissionCleared(item) ? (
                          <Badge variant="success">已结清</Badge>
                        ) : (
                          <span className="text-muted-foreground">未结清</span>
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
                <TableCell colSpan={BUSINESS_DAILY_ORDER_COLUMNS.length + 1} className="py-12 text-center text-muted-foreground">
                  没有符合筛选条件的订单
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

      <Dialog
        open={Boolean(customerOrder)}
        onOpenChange={(open) => {
          if (!open) {
            setCustomerOrder(null)
            setCustomerDraft(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{customerOrder?.customer_id ? '更换订单客户' : '绑定订单客户'}</DialogTitle>
            <DialogDescription>
              保存后立即同步订单与客户库关联，不改变订单审批状态。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>客户</Label>
            <CustomerCombobox
              customers={customers}
              groups={customerGroups}
              value={customerDraft}
              onChange={setCustomerDraft}
              allowCreate
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={customerPending}
              onClick={() => setCustomerOrder(null)}
            >
              取消
            </Button>
            {customerOrder?.customer_id && (
              <Button
                type="button"
                variant="destructive"
                disabled={customerPending}
                onClick={() => saveCustomer(null)}
              >
                取消绑定
              </Button>
            )}
            <Button
              type="button"
              disabled={customerPending || !customerDraft}
              onClick={() => saveCustomer(customerDraft)}
            >
              {customerPending ? '保存中…' : '保存客户'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(attachmentUrl)} onOpenChange={(open) => !open && setAttachmentUrl(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>订单截图</DialogTitle>
          </DialogHeader>
          {attachmentUrl && (
            // Signed Storage URLs cannot be optimized by next/image.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={attachmentUrl}
              alt="订单截图"
              className="mx-auto h-auto max-h-[75vh] max-w-full object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
