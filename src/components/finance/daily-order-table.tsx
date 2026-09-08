'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Eye, Pencil, Trash2 } from 'lucide-react'
import { useMemo, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getDailyOrderScreenshotUrl, voidDailyOrder } from '@/lib/actions/daily-orders'
import { formatDailyMoney, PAYMENT_LABELS, SHIPPING_LABELS } from '@/lib/daily-orders'
import { displayProfileName } from '@/lib/utils'
import type { DailyOrder } from '@/types'

interface DailyOrderGroup {
  key: string
  rows: DailyOrder[]
}

function dailyOrderGroupKey(order: DailyOrder) {
  if (order.workflow_id) return `workflow:${order.workflow_id}`
  return JSON.stringify([
    'legacy',
    order.salesperson_id ?? order.salesperson_name_snapshot,
    order.shop_id ?? order.shop_name_snapshot,
    order.order_number,
  ])
}

function groupDailyOrders(orders: DailyOrder[]) {
  const groups: DailyOrderGroup[] = []
  const groupIndexes = new Map<string, number>()

  orders.forEach((order) => {
    const key = dailyOrderGroupKey(order)
    const existingIndex = groupIndexes.get(key)
    if (existingIndex === undefined) {
      groupIndexes.set(key, groups.length)
      groups.push({ key, rows: [order] })
      return
    }
    groups[existingIndex].rows.push(order)
  })

  return groups
}

const mergedCellClassName = 'bg-muted/20 align-top'

function distinctValues(rows: DailyOrder[], select: (order: DailyOrder) => string) {
  return Array.from(new Set(rows.map(select)))
}

function MergedValues({ values }: { values: string[] }) {
  return (
    <div>
      {values.map((value) => <div key={value}>{value}</div>)}
      {values.length > 1 && <div className="mt-1 text-xs text-destructive">明细值不一致</div>}
    </div>
  )
}

export function DailyOrderTable({ orders, readOnly = false }: { orders: DailyOrder[]; readOnly?: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const groups = useMemo(() => groupDailyOrders(orders), [orders])

  function voidRow(order: DailyOrder) {
    if (!window.confirm(`确定作废订单行 ${order.order_number} / ${order.product_name_snapshot} 吗？`)) return
    startTransition(async () => {
      const result = await voidDailyOrder(order.id, order.version)
      if (!result.ok) {
        toast.error(result.error ?? '作废失败')
        return
      }
      toast.success('订单行已作废')
      router.refresh()
    })
  }

  function view(id: string) {
    startTransition(async () => {
      const result = await getDailyOrderScreenshotUrl(id)
      if (result.url) window.open(result.url, '_blank', 'noopener,noreferrer')
      else toast.error(result.error ?? '无法查看截图')
    })
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table className="min-w-[2450px]">
        <TableHeader><TableRow>
          {['序号','下单日期','店铺','业务员','订单号','发货日期','发货单号','发货分类','产品名称','数量','销售单价','产品实收金额','运费实收金额','销售总金额','收款分类','备注','截图'].map((label) => <TableHead key={label}>{label}</TableHead>)}
        </TableRow></TableHeader>
        <TableBody>
          {groups.map((group, groupIndex) => {
            const rowSpan = group.rows.length
            const orderDates = distinctValues(group.rows, (order) => order.order_date)
            const shops = distinctValues(group.rows, (order) => order.shop_name_snapshot)
            const salespeople = distinctValues(group.rows, (order) => displayProfileName(order.salesperson, order.salesperson_name_snapshot))
            const orderNumbers = distinctValues(group.rows, (order) => order.order_number)
            const shippingDates = distinctValues(group.rows, (order) => order.shipping_date)
            const shippingNumbers = distinctValues(group.rows, (order) => order.shipping_number || '—')
            const paymentCategories = distinctValues(group.rows, (order) => PAYMENT_LABELS[order.payment_category])
            const remarks = distinctValues(group.rows, (order) => order.remarks || '—')

            return group.rows.map((order, rowIndex) => {
              const isFirstRow = rowIndex === 0
              const screenshots = (order.finance_daily_order_screenshots ?? []).filter((shot) => shot.status === 'active')
              return (
                <TableRow key={order.id} className={isFirstRow && groupIndex > 0 ? 'border-t-2' : undefined}>
                  <TableCell>
                    <div className="font-medium">
                      {groupIndex + 1}
                      {rowSpan > 1 && <span className="ml-1 text-xs text-muted-foreground">-{rowIndex + 1}</span>}
                    </div>
                    {!readOnly && <div className="flex"><Button asChild variant="ghost" size="icon"><Link href={`/finance/daily-orders/${order.id}/edit`} aria-label={`编辑 ${order.product_name_snapshot}`}><Pencil className="h-3.5 w-3.5" /></Link></Button><Button variant="ghost" size="icon" disabled={pending} onClick={() => voidRow(order)} aria-label={`作废 ${order.product_name_snapshot}`}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button></div>}
                  </TableCell>
                  {isFirstRow && (
                    <>
                      <TableCell rowSpan={rowSpan} className={mergedCellClassName}><MergedValues values={orderDates} /></TableCell>
                      <TableCell rowSpan={rowSpan} className={mergedCellClassName}><MergedValues values={shops} /></TableCell>
                      <TableCell rowSpan={rowSpan} className={mergedCellClassName}><MergedValues values={salespeople} /></TableCell>
                      <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} font-medium`}>
                        <MergedValues values={orderNumbers} />
                        {rowSpan > 1 && <div className="mt-1 text-xs font-normal text-muted-foreground">{rowSpan} 个产品</div>}
                      </TableCell>
                      <TableCell rowSpan={rowSpan} className={mergedCellClassName}><MergedValues values={shippingDates} /></TableCell>
                      <TableCell rowSpan={rowSpan} className={mergedCellClassName}><MergedValues values={shippingNumbers} /></TableCell>
                    </>
                  )}
                  <TableCell>{SHIPPING_LABELS[order.shipping_category]}</TableCell>
                  <TableCell><div>{order.product_name_snapshot}</div><div className="text-xs text-muted-foreground">{order.product_sku_snapshot}</div></TableCell>
                  <TableCell className="tabular-nums">{Number(order.quantity).toLocaleString()}</TableCell>
                  <TableCell>{formatDailyMoney(order.sales_unit_price_amount, order.sales_unit_price_currency)}</TableCell>
                  <TableCell>{formatDailyMoney(order.product_received_amount, order.product_received_currency)}</TableCell>
                  <TableCell>{formatDailyMoney(order.logistics_fee_amount, order.logistics_fee_currency)}</TableCell>
                  <TableCell className="font-medium">{formatDailyMoney(order.sales_total_amount, order.sales_total_currency)}</TableCell>
                  {isFirstRow && (
                    <>
                      <TableCell rowSpan={rowSpan} className={mergedCellClassName}><MergedValues values={paymentCategories} /></TableCell>
                      <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} max-w-64 whitespace-normal`}><MergedValues values={remarks} /></TableCell>
                    </>
                  )}
                  <TableCell>{screenshots.map((shot, shotIndex) => <Button key={shot.id} type="button" variant="ghost" size="sm" onClick={() => view(shot.id)}>{shotIndex + 1}<Eye className="ml-1 h-3 w-3" /></Button>)}</TableCell>
                </TableRow>
              )
            })
          })}
          {orders.length === 0 && <TableRow><TableCell colSpan={17} className="py-12 text-center text-muted-foreground">没有符合筛选条件的订单</TableCell></TableRow>}
        </TableBody>
      </Table>
    </div>
  )
}
