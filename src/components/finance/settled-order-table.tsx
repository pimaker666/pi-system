'use client'

import Link from 'next/link'
import { useMemo, useRef, useState, useTransition } from 'react'
import { RotateCcw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
  '选择',
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
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [unsettleItemIds, setUnsettleItemIds] = useState<string[] | null>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  const [pinnedCol, setPinnedCol] = useState<number | null>(null)

  // 冻结用户点击「固定」时视口最左侧的那一列，而不是永远固定首列。
  function togglePin(checked: boolean) {
    if (!checked) {
      setPinnedCol(null)
      return
    }
    const table = tableRef.current
    const scrollContainer = table?.closest('main')
    const headerRow = table?.tHead?.rows[0]
    if (!table || !scrollContainer || !headerRow) return
    const scrollLeft = scrollContainer.scrollLeft
    let target = 0
    for (let i = 0; i < headerRow.cells.length; i += 1) {
      if ((headerRow.cells[i] as HTMLElement).offsetLeft <= scrollLeft + 1) target = i
      else break
    }
    setPinnedCol(target)
  }

  // 单元格按列渲染上千次，直接用字符串拼接，避免每格走一遍 tailwind-merge。
  const headCn = (index: number, extra = '') =>
    `sticky top-0 border-b border-slate-200 bg-slate-100/95 text-xs font-semibold text-slate-700 backdrop-blur ${
      pinnedCol === index ? 'left-0 z-30 shadow-[4px_0_8px_rgb(15_23_42/0.08)]' : 'z-20'
    } ${extra}`.trim()
  const cellCn = (index: number, extra = '') =>
    pinnedCol === index
      ? `${extra} sticky left-0 z-10 bg-card shadow-[4px_0_8px_rgb(15_23_42/0.06)]`.trim()
      : extra
  const mergedCn = (index: number, extra = '') =>
    pinnedCol === index
      ? `align-top sticky left-0 z-10 bg-slate-50 shadow-[4px_0_8px_rgb(15_23_42/0.06)] ${extra}`.trim()
      : `align-top bg-muted/20 ${extra}`.trim()

  const groups = useMemo(() => {
    const map = new Map<string, SettledOrderRow[]>()
    for (const row of rows) {
      const list = map.get(row.order_id) ?? []
      list.push(row)
      map.set(row.order_id, list)
    }
    return [...map.values()]
  }, [rows])
  const allSelected = rows.length > 0 && rows.every((row) => selectedItemIds.has(row.business_order_item_id))

  function toggleRow(itemId: string, checked: boolean) {
    setSelectedItemIds((previous) => {
      const next = new Set(previous)
      if (checked) next.add(itemId)
      else next.delete(itemId)
      return next
    })
  }

  function toggleSelectAll(checked: boolean) {
    setSelectedItemIds(checked ? new Set(rows.map((row) => row.business_order_item_id)) : new Set())
  }

  function confirmUnsettle() {
    if (!unsettleItemIds?.length) return
    startTransition(async () => {
      const result = await unsettleBusinessOrderItems({ business_order_item_ids: unsettleItemIds })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '取消结算失败')
        return
      }
      toast.success(`已取消 ${unsettleItemIds.length} 个产品行结算`)
      setSelectedItemIds(new Set())
      setUnsettleItemIds(null)
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
        <div className="flex items-center gap-2">
          <Button type="submit">筛选</Button>
          <Button asChild type="button" variant="outline">
            <Link href="/finance/settled-orders">清空</Link>
          </Button>
          <label className="flex h-10 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={pinnedCol !== null}
              onChange={(event) => togglePin(event.target.checked)}
              className="accent-primary"
            />
            固定当前列
          </label>
        </div>
      </form>

      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-card p-3">
          <span className="text-sm text-muted-foreground">已选 {selectedItemIds.size} 个产品行</span>
          <Button
            type="button"
            variant="outline"
            disabled={selectedItemIds.size === 0 || pending}
            onClick={() => setUnsettleItemIds([...selectedItemIds])}
          >
            <RotateCcw className="mr-1.5 h-4 w-4" />
            取消结算
          </Button>
        </div>
      )}

      <Table
        ref={tableRef}
        containerClassName="min-w-[1600px] overflow-visible rounded-md border"
        className="min-w-[1600px]"
      >
        <TableHeader>
          <TableRow>
            <TableHead className={headCn(0, 'w-12')}>
              <input
                type="checkbox"
                aria-label="全选"
                checked={allSelected}
                onChange={(event) => toggleSelectAll(event.target.checked)}
              />
            </TableHead>
            {COLUMNS.slice(1).map((label, columnIndex) => (
              <TableHead key={label} className={headCn(columnIndex + 1)}>
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
              return (
                <TableRow
                  key={row.business_order_item_id}
                  className={isFirstRow && groupIndex > 0 ? 'border-t-2' : undefined}
                >
                  <TableCell className={cellCn(0)}>
                    <input
                      type="checkbox"
                      aria-label={`选择产品行 ${row.product_name}`}
                      checked={selectedItemIds.has(row.business_order_item_id)}
                      onChange={(event) => toggleRow(row.business_order_item_id, event.target.checked)}
                    />
                  </TableCell>
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
                        {row.period}
                      </TableCell>
                      <TableCell rowSpan={rowSpan} className={mergedCn(3)}>
                        {row.order_date}
                      </TableCell>
                      <TableCell rowSpan={rowSpan} className={mergedCn(4)}>
                        <div>{row.shop_name ?? '—'}</div>
                        {row.shop_group_name && (
                          <div className="text-xs text-muted-foreground">{row.shop_group_name}</div>
                        )}
                      </TableCell>
                      <TableCell rowSpan={rowSpan} className={mergedCn(5)}>
                        {row.salesperson_name}
                      </TableCell>
                      <TableCell rowSpan={rowSpan} className={mergedCn(6, 'font-medium')}>
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
                  <TableCell className={cellCn(7)}>
                    {row.shipping_category ? SHIPPING_LABELS[row.shipping_category] : '—'}
                  </TableCell>
                  <TableCell className={cellCn(8, 'min-w-52')}>
                    <div className="font-medium">{row.product_name}</div>
                    {row.product_name_snapshot &&
                      row.product_name_snapshot.trim().toLocaleLowerCase() !==
                        row.product_name.trim().toLocaleLowerCase() && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {row.product_name_snapshot}
                        </div>
                      )}
                    {row.product_sku && (
                      <div className="mt-0.5 text-xs text-muted-foreground">{row.product_sku}</div>
                    )}
                  </TableCell>
                  <TableCell className={cellCn(9, 'text-right tabular-nums')}>
                    {quantityText(row.quantity)}
                  </TableCell>
                  <TableCell className={cellCn(10, 'tabular-nums')}>
                    {formatCostValue(row.unit_cost)}
                  </TableCell>
                  <TableCell className={cellCn(11, 'tabular-nums')}>
                    {formatCostValue(row.total_cost)}
                  </TableCell>
                  <TableCell className={cellCn(12, 'whitespace-nowrap text-xs text-muted-foreground')}>
                    {row.settled_by_name ?? '—'}
                  </TableCell>
                  <TableCell className={cellCn(13)}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => setUnsettleItemIds([row.business_order_item_id])}
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

      <AlertDialog open={unsettleItemIds != null} onOpenChange={(open) => !open && setUnsettleItemIds(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认取消结算？</AlertDialogTitle>
            <AlertDialogDescription>
              将取消 {unsettleItemIds?.length ?? 0} 个产品行的成本结算，产品行会回到订单成本页。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={confirmUnsettle}>
              确认取消结算
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
