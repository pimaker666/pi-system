'use client'

import Link from 'next/link'
import { useMemo, useState, useTransition } from 'react'
import { RotateCcw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
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
import { unsettleBusinessOrderItems } from '@/lib/actions/finance'
import { formatCostValue } from '@/lib/business-order-cost'
import { formatDailyMoney, SHIPPING_LABELS } from '@/lib/daily-orders'
import type { SettledOrderRow } from '@/types'

const COLUMNS = [
  '序号',
  '结算年月',
  '下单日期',
  '店铺',
  '业务员',
  '订单号',
  '发货分类',
  '产品名称',
  '数量',
  '单位成本',
  '总成本',
  '结算人',
  '操作',
]

function quantityText(value: number) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value)
}

export interface SettledOrderTableProps {
  rows: SettledOrderRow[]
  periods: string[]
  filters: { period: string | null; q: string }
}

export function SettledOrderTable({ rows, periods, filters }: SettledOrderTableProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [pendingId, setPendingId] = useState<string | null>(null)

  const groups = useMemo(() => {
    const map = new Map<string, SettledOrderRow[]>()
    for (const row of rows) {
      const list = map.get(row.order_id) ?? []
      list.push(row)
      map.set(row.order_id, list)
    }
    return [...map.values()]
  }, [rows])

  function cancelSettlement(itemId: string) {
    setPendingId(itemId)
    startTransition(async () => {
      const result = await unsettleBusinessOrderItems({ business_order_item_ids: [itemId] })
      setPendingId(null)
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '取消结算失败')
        return
      }
      toast.success('已取消结算，产品行回到订单成本页')
      router.refresh()
    })
  }

  return (
    <section className="space-y-4">
      <form className="flex flex-wrap items-end gap-3 rounded-md border p-4">
        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="settled-period">
            结算年月
          </label>
          <select
            id="settled-period"
            name="period"
            defaultValue={filters.period ?? ''}
            className="h-10 rounded-md border bg-background px-3 text-sm"
          >
            <option value="">全部年月</option>
            {periods.map((period) => (
              <option key={period} value={period}>
                {period}
              </option>
            ))}
          </select>
        </div>
        <div className="grid flex-1 gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="settled-q">
            搜索
          </label>
          <Input
            id="settled-q"
            name="q"
            defaultValue={filters.q}
            placeholder="订单号/平台单号/产品/SKU"
            className="min-w-56"
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit">筛选</Button>
          <Button asChild type="button" variant="outline">
            <Link href="/finance/settled-orders">清空</Link>
          </Button>
        </div>
      </form>

      <div className="overflow-x-auto rounded-md border">
        <Table className="min-w-[1600px]">
          <TableHeader>
            <TableRow>
              {COLUMNS.map((label) => (
                <TableHead key={label}>{label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group, groupIndex) => {
              const rowSpan = group.length
              return group.map((row, rowIndex) => {
                const isFirstRow = rowIndex === 0
                const displayOrderNumber = row.external_order_number || row.order_number
                return (
                  <TableRow
                    key={row.business_order_item_id}
                    className={isFirstRow && groupIndex > 0 ? 'border-t-2' : undefined}
                  >
                    <TableCell>
                      <div className="font-medium">
                        {groupIndex + 1}
                        {rowSpan > 1 && (
                          <span className="ml-1 text-xs text-muted-foreground">-{rowIndex + 1}</span>
                        )}
                      </div>
                    </TableCell>
                    {isFirstRow && (
                      <>
                        <TableCell rowSpan={rowSpan} className="bg-muted/20 align-top">
                          {row.period}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className="bg-muted/20 align-top">
                          {row.order_date}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className="bg-muted/20 align-top">
                          <div>{row.shop_name ?? '—'}</div>
                          {row.shop_group_name && (
                            <div className="text-xs text-muted-foreground">{row.shop_group_name}</div>
                          )}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className="bg-muted/20 align-top">
                          {row.salesperson_name}
                        </TableCell>
                        <TableCell rowSpan={rowSpan} className="bg-muted/20 align-top font-medium">
                          <Link
                            href={`/finance/daily-orders/${row.order_id}`}
                            className="hover:underline"
                          >
                            {displayOrderNumber}
                          </Link>
                          {row.external_order_number && (
                            <div className="text-xs font-normal text-muted-foreground">
                              {row.order_number}
                            </div>
                          )}
                          <div className="text-xs font-normal text-muted-foreground">
                            {row.customer_name || '—'}
                          </div>
                        </TableCell>
                      </>
                    )}
                    <TableCell>
                      {row.shipping_category ? SHIPPING_LABELS[row.shipping_category] : '—'}
                    </TableCell>
                    <TableCell>
                      <div>{row.product_name}</div>
                      {row.product_sku && (
                        <div className="text-xs text-muted-foreground">{row.product_sku}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {quantityText(row.quantity)}
                    </TableCell>
                    <TableCell className="tabular-nums">{formatCostValue(row.unit_cost)}</TableCell>
                    <TableCell className="tabular-nums">{formatCostValue(row.total_cost)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {row.settled_by_name ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending && pendingId === row.business_order_item_id}
                        onClick={() => cancelSettlement(row.business_order_item_id)}
                      >
                        <RotateCcw className="mr-1 h-3 w-3" />
                        取消结算
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={COLUMNS.length} className="py-12 text-center text-muted-foreground">
                  暂无已结算的订单产品行
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}
