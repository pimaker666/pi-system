'use client'

import Link from 'next/link'
import { useMemo, useRef, useState, useTransition } from 'react'
import { Download, Eye, Save, CheckCircle2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DateRangePicker } from '@/components/shared/date-range-picker'
import { ImagePreview } from '@/components/ui/image-preview'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
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
  settleBusinessOrderItems,
  updateBusinessOrderItemCostOverride,
} from '@/lib/actions/finance'
import {
  BUSINESS_ORDER_COST_COLUMNS,
  COST_PAGE_SIZE,
  businessOrderCostFilterQuery,
  formatCostValue,
} from '@/lib/business-order-cost'
import {
  BUSINESS_ORDER_STATUS_LABELS,
  BUSINESS_ORDER_STATUS_VARIANTS,
} from '@/lib/business-orders'
import { formatDailyMoney, PAYMENT_LABELS, SHIPPING_LABELS } from '@/lib/daily-orders'
import { cn, displayProfileName } from '@/lib/utils'
import type { BusinessOrderCostFilters } from '@/schemas/business-order-cost'
import type {
  BusinessOrderProductCost,
  DailyOrderShop,
  DailyOrderShopGroup,
  Profile,
} from '@/types'

function quantityText(value: number) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value)
}

function CostEditor({ row }: { row: BusinessOrderProductCost }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const initialValue = row.cost == null ? '' : String(row.cost)
  const [draft, setDraft] = useState(initialValue)
  const normalized = draft.trim()
  const unchanged = normalized === initialValue

  if (!row.fully_shipped || row.product_name === '—') {
    return <span className="text-muted-foreground">—</span>
  }

  function save() {
    const cost = normalized === '' ? null : Number(normalized)
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) {
      toast.error('成本必须是非负数字')
      return
    }

    startTransition(async () => {
      const result = await updateBusinessOrderItemCostOverride({
        business_order_item_ids: row.item_ids,
        cost,
      })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '成本保存失败')
        return
      }
      toast.success(cost === null ? '已恢复产品库成本' : '订单行成本已保存')
      router.refresh()
    })
  }

  return (
    <div className="flex min-w-44 items-center gap-2">
      <div className="relative flex-1">
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          ¥
        </span>
        <Input
          value={draft}
          type="number"
          min={0}
          step="0.0001"
          disabled={pending}
          placeholder={row.shipping_category === 'custom' ? '定制订单留空' : '未匹配成本'}
          title="成本以人民币计；留空保存可恢复产品库自动匹配成本"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !pending && !unchanged) {
              event.preventDefault()
              save()
            }
          }}
          className="h-8 pl-5"
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8 shrink-0"
        disabled={pending || unchanged}
        onClick={save}
        aria-label={`保存订单 ${row.order_number} 的产品成本`}
        title="保存；留空则恢复产品库成本"
      >
        <Save className="h-4 w-4" />
      </Button>
      {row.cost_overridden && <span className="whitespace-nowrap text-xs text-muted-foreground">已修改</span>}
    </div>
  )
}

interface Option {
  id: string
  name: string
}

function MultiSelect({
  name,
  label,
  options,
  selected,
}: {
  name: string
  label: string
  options: Option[]
  selected: string[]
}) {
  const selectedSet = new Set(selected)
  const count = options.filter((o) => selectedSet.has(o.id)).length
  return (
    <details className="group relative">
      <summary className="flex h-10 cursor-pointer items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm [&::-webkit-details-marker]:hidden">
        <span className="truncate">{count ? `${label} (${count})` : `全部${label}`}</span>
        <span aria-hidden className="text-xs text-muted-foreground">▼</span>
      </summary>
      <div className="absolute z-50 mt-1 max-h-64 w-56 overflow-auto rounded-md border bg-background p-2 shadow-md">
        {options.map((option) => (
          <label
            key={option.id}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
          >
            <input
              type="checkbox"
              name={name}
              value={option.id}
              defaultChecked={selectedSet.has(option.id)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <span className="truncate">{option.name}</span>
          </label>
        ))}
      </div>
    </details>
  )
}

export interface DailyOrderCostManagerProps {
  rows: BusinessOrderProductCost[]
  totalCount: number
  filters: BusinessOrderCostFilters
  options: {
    shops: DailyOrderShop[]
    groups: DailyOrderShopGroup[]
    salespeople: Pick<Profile, 'id' | 'full_name' | 'email' | 'chinese_name'>[]
  }
}

export function DailyOrderCostManager({ rows, totalCount, filters, options }: DailyOrderCostManagerProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [settlePending, startSettleTransition] = useTransition()
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7))
  const tableRef = useRef<HTMLTableElement>(null)
  const [pinnedCol, setPinnedCol] = useState<number | null>(null)
  const query = businessOrderCostFilterQuery(filters)
  const currentPage = filters.page
  const totalPages = Math.max(1, Math.ceil(totalCount / COST_PAGE_SIZE))

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

  const groups = useMemo(() => {
    const map = new Map<string, BusinessOrderProductCost[]>()
    for (const row of rows) {
      const list = map.get(row.order_id) ?? []
      list.push(row)
      map.set(row.order_id, list)
    }
    return [...map.values()]
  }, [rows])

  const orderIds = useMemo(() => groups.map((group) => group[0].order_id), [groups])
  const ordersMissingCost = useMemo(() => {
    const set = new Set<string>()
    for (const row of rows) {
      if (row.cost == null) set.add(row.order_id)
    }
    return set
  }, [rows])
  const settleableOrderIds = useMemo(
    () => orderIds.filter((id) => !ordersMissingCost.has(id)),
    [orderIds, ordersMissingCost],
  )
  const selectedCount = useMemo(
    () => orderIds.filter((id) => selectedOrders.has(id)).length,
    [orderIds, selectedOrders],
  )
  const allSelected =
    settleableOrderIds.length > 0 && settleableOrderIds.every((id) => selectedOrders.has(id))

  function toggleOrder(orderId: string, checked: boolean) {
    if (checked && ordersMissingCost.has(orderId)) {
      toast.error('该订单存在未填写成本的产品行，不能结算')
      return
    }
    setSelectedOrders((previous) => {
      const next = new Set(previous)
      if (checked) next.add(orderId)
      else next.delete(orderId)
      return next
    })
  }

  function toggleSelectAll(checked: boolean) {
    setSelectedOrders(checked ? new Set(settleableOrderIds) : new Set())
  }

  function confirmSettle() {
    const selectedRows = rows.filter((row) => selectedOrders.has(row.order_id))
    if (selectedRows.some((row) => row.cost == null)) {
      toast.error('存在未填写成本的产品行，不能结算')
      return
    }
    const itemIds = selectedRows.flatMap((row) => row.item_ids)
    if (itemIds.length === 0) {
      toast.error('请先勾选订单')
      return
    }
    startSettleTransition(async () => {
      const result = await settleBusinessOrderItems({
        business_order_item_ids: itemIds,
        period,
      })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '结算失败')
        return
      }
      toast.success(`已结算 ${selectedCount} 个订单至 ${period}`)
      setSelectedOrders(new Set())
      setDialogOpen(false)
      router.refresh()
    })
  }

  function viewAttachment(attachmentId: string) {
    startTransition(async () => {
      const result = await getBusinessOrderAttachmentUrl(attachmentId)
      if (result.url) window.open(result.url, '_blank', 'noopener,noreferrer')
      else toast.error(result.error ?? '无法查看截图')
    })
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">已收款并发货的产品成本</h2>
          <p className="text-sm text-muted-foreground">
            产品行实收已达到产品应收且全部发货后即可计算并编辑成本。
            修改成本仅覆盖当前订单行，不反写产品库。
          </p>
        </div>
        <Button asChild variant="outline">
          <a download href={`/api/finance/costs/export/xlsx${query ? `?${query}` : ''}`}>
            <Download className="h-4 w-4" />
            导出成本表
          </a>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
        <span className="text-sm text-muted-foreground">已选 {selectedCount} 个订单</span>
        <Button
          type="button"
          disabled={selectedCount === 0 || settlePending}
          onClick={() => setDialogOpen(true)}
        >
          <CheckCircle2 className="mr-1.5 h-4 w-4" />
          已结算
        </Button>
        <span className="text-xs text-muted-foreground">
          结算后所选订单的产品行将移入“已结算订单”，不再显示在此页。
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={pinnedCol !== null}
            onChange={(event) => togglePin(event.target.checked)}
          />
          固定当前列
        </label>
      </div>

      <form className="grid gap-3 rounded-md border p-4 md:grid-cols-4 xl:grid-cols-9">
        <input type="hidden" name="page" value="1" />
        <Input
          name="q"
          defaultValue={filters.q}
          placeholder="订单号/平台单号/发货单号/收款账户/产品/SKU"
          className="xl:col-span-2"
        />
        <DateRangePicker from={filters.dateFrom} to={filters.dateTo} className="md:col-span-2" />
        <MultiSelect
          name="shops"
          label="店铺"
          options={options.shops.map((shop) => ({ id: shop.id, name: shop.name }))}
          selected={filters.shops}
        />
        <MultiSelect
          name="salespeople"
          label="业务员"
          options={options.salespeople.map((person) => ({
            id: person.id,
            name: displayProfileName(person),
          }))}
          selected={filters.salespeople}
        />
        <MultiSelect
          name="shopGroups"
          label="店铺分组"
          options={options.groups.map((group) => ({ id: group.id, name: group.name }))}
          selected={filters.shopGroups}
        />
        <div className="flex flex-wrap gap-2 xl:col-span-9">
          <Button type="submit">筛选</Button>
          <Button asChild type="button" variant="outline">
            <Link href="/finance/costs">清空</Link>
          </Button>
        </div>
      </form>

      <Table
        ref={tableRef}
        containerClassName="max-h-[70vh] overflow-auto rounded-md border"
        className="min-w-[3000px]"
      >
        <TableHeader>
          <TableRow>
            <TableHead className={headCn(0, 'w-12')}>
              {orderIds.length > 0 && (
                <input
                  type="checkbox"
                  aria-label="全选"
                  checked={allSelected}
                  onChange={(event) => toggleSelectAll(event.target.checked)}
                />
              )}
            </TableHead>
            {BUSINESS_ORDER_COST_COLUMNS.map((label, index) => (
              <TableHead key={label} className={headCn(index + 1)}>
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
            {groups.map((group, groupIndex) => {
              const rowSpan = group.length
              return group.map((row, rowIndex) => {
                const isFirstRow = rowIndex === 0
                const displayOrderNumber = row.external_order_number || row.order_number
                const difference = Math.round((row.order_total_amount - row.order_sales_total_amount) * 100) / 100

                return (
                  <TableRow
                    key={row.item_id}
                    className={isFirstRow && groupIndex > 0 ? 'border-t-2' : undefined}
                  >
                    {isFirstRow && (
                      <TableCell rowSpan={rowSpan} className={cellCn(0, 'align-top')}>
                        <input
                          type="checkbox"
                          aria-label={`选择订单 ${row.order_number}`}
                          checked={selectedOrders.has(row.order_id)}
                          disabled={ordersMissingCost.has(row.order_id)}
                          title={
                            ordersMissingCost.has(row.order_id)
                              ? '存在未填写成本的产品行，不能结算'
                              : undefined
                          }
                          onChange={(event) => toggleOrder(row.order_id, event.target.checked)}
                        />
                      </TableCell>
                    )}
                    <TableCell className={cellCn(1)}>
                      <div className="font-medium">
                        {groupIndex + 1}
                        {rowSpan > 1 && (
                          <span className="ml-1 text-xs text-muted-foreground">-{rowIndex + 1}</span>
                        )}
                      </div>
                    </TableCell>

                    {isFirstRow && (
                      <>
                        <TableCell rowSpan={rowSpan} className={mergedCn(2)}>
                          {row.order_date}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={mergedCn(3)}>
                          <div>{row.shop_name ?? '—'}</div>
                          {row.shop_group_name && (
                            <div className="text-xs text-muted-foreground">{row.shop_group_name}</div>
                          )}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={mergedCn(4)}>
                          {row.salesperson_name}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={mergedCn(5, 'font-medium')}>
                          <Link href={`/finance/daily-orders/${row.order_id}`} className="hover:underline">
                            {displayOrderNumber}
                          </Link>
                          {row.external_order_number && (
                            <div className="text-xs font-normal text-muted-foreground">{row.order_number}</div>
                          )}
                          <div
                            className="text-xs font-normal"
                            style={{ color: row.customer_tag_color ?? undefined }}
                          >
                            {row.customer_name || '—'}
                          </div>
                          <div className="mt-1 space-y-0.5 text-xs font-normal tabular-nums">
                            <div>应收 {formatDailyMoney(row.order_total_amount, row.currency)}</div>
                            <div>实收 {formatDailyMoney(row.order_sales_total_amount, row.currency)}</div>
                            <div className={difference === 0 ? 'text-muted-foreground' : 'text-amber-700'}>
                              差额 {formatDailyMoney(difference, row.currency)}
                            </div>
                          </div>
                          <div className="mt-1">
                            {row.order_closed_at ? (
                              <Badge variant="secondary">特殊关闭</Badge>
                            ) : (
                              <Badge variant={BUSINESS_ORDER_STATUS_VARIANTS[row.order_status]}>
                                {BUSINESS_ORDER_STATUS_LABELS[row.order_status]}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={mergedCn(6)}>
                          {row.shipping_date ?? '—'}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={mergedCn(7)}>
                          {row.payment_account || row.shipping_number || '—'}
                        </TableCell>
                      </>
                    )}

                    <TableCell className={cellCn(8)}>
                      {row.shipping_category ? SHIPPING_LABELS[row.shipping_category] : '—'}
                    </TableCell>
                    <TableCell className={cellCn(9)}>
                      <ImagePreview src={row.image_url} alt={row.product_name} />
                    </TableCell>
                    <TableCell className={cellCn(10)}>
                      <div>{row.product_name}</div>
                      {row.product_sku && (
                        <div className="text-xs text-muted-foreground">{row.product_sku}</div>
                      )}
                    </TableCell>
                    <TableCell className={cellCn(11, 'text-right tabular-nums')}>{quantityText(row.quantity)}</TableCell>
                    <TableCell className={cellCn(12)}>
                      <CostEditor row={row} />
                    </TableCell>
                    <TableCell className={cellCn(13, 'tabular-nums')}>{formatCostValue(row.total_cost)}</TableCell>
                    <TableCell className={cellCn(14, 'whitespace-nowrap tabular-nums')}>{row.shipping_progress}</TableCell>
                    <TableCell className={cellCn(15)}>{formatDailyMoney(row.unit_price, row.currency)}</TableCell>
                    <TableCell className={cellCn(16)}>{formatDailyMoney(row.product_received_amount, row.currency)}</TableCell>
                    <TableCell className={cellCn(17)}>
                      {row.logistics_fee_amount !== null
                        ? formatDailyMoney(row.logistics_fee_amount, row.currency)
                        : '—'}
                    </TableCell>

                    {isFirstRow && (
                      <>
                        <TableCell rowSpan={rowSpan} className={mergedCn(18, 'font-medium')}>
                          {formatDailyMoney(row.order_total_amount, row.currency)}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={mergedCn(19, 'font-medium')}>
                          {formatDailyMoney(row.outstanding_amount, row.currency)}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={mergedCn(20)}>
                          {row.payment_category ? PAYMENT_LABELS[row.payment_category] : '—'}
                        </TableCell>
                        <TableCell
                          rowSpan={rowSpan}
                          className={mergedCn(21, 'max-w-64 whitespace-normal')}
                        >
                          {row.sales_notes || '—'}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className={mergedCn(22)}>
                          {row.attachments.length === 0
                            ? '—'
                            : row.attachments.map((attachment, attachmentIndex) => (
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
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={BUSINESS_ORDER_COST_COLUMNS.length + 1}
                  className="py-12 text-center text-muted-foreground"
                >
                  没有符合筛选条件的订单
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            共 {totalCount} 条订单，第 {currentPage}/{totalPages} 页
          </span>
          <div className="flex items-center gap-1">
            {currentPage > 1 && (
              <Link
                href={`/finance/costs?${businessOrderCostFilterQuery({ ...filters, page: currentPage - 1 })}`}
                className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted"
              >
                上一页
              </Link>
            )}
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 2)
              .reduce<(number | 'ellipsis')[]>((acc, p, i, arr) => {
                if (i > 0 && p - (arr[i - 1] as number) > 1) acc.push('ellipsis')
                acc.push(p)
                return acc
              }, [])
              .map((item, i) =>
                item === 'ellipsis' ? (
                  <span key={`e${i}`} className="px-1 text-muted-foreground">…</span>
                ) : (
                  <Link
                    key={item}
                    href={`/finance/costs?${businessOrderCostFilterQuery({ ...filters, page: item })}`}
                    className={`inline-flex h-8 min-w-8 items-center justify-center rounded-md text-sm ${
                      item === currentPage
                        ? 'bg-primary text-primary-foreground'
                        : 'border hover:bg-muted'
                    }`}
                  >
                    {item}
                  </Link>
                ),
              )}
            {currentPage < totalPages && (
              <Link
                href={`/finance/costs?${businessOrderCostFilterQuery({ ...filters, page: currentPage + 1 })}`}
                className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted"
              >
                下一页
              </Link>
            )}
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>结算至</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              将所选 {selectedCount} 个订单的产品行归档到指定年月，归档后不再显示在此页。
            </p>
            <label className="block text-sm font-medium" htmlFor="settle-period">
              结算年月
            </label>
            <Input
              id="settle-period"
              type="month"
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              disabled={settlePending || !period}
              onClick={confirmSettle}
            >
              确认结算
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
