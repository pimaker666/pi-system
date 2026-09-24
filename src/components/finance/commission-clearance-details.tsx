'use client'

import Link from 'next/link'
import { useMemo, useState, useTransition } from 'react'
import { ListChecks, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  markBusinessOrderCommissionRejectionsRead,
  withdrawBusinessOrderCommissionClearance,
} from '@/lib/actions/commission'
import type { BusinessOrderCommissionClearanceDetail, CommissionClearanceStatus } from '@/types'

function statusLabel(status: CommissionClearanceStatus) {
  if (status === 'pending') return '待确认'
  if (status === 'confirmed') return '已确认'
  return '已驳回'
}

function statusVariant(status: CommissionClearanceStatus) {
  if (status === 'pending') return 'default'
  if (status === 'confirmed') return 'success'
  return 'destructive'
}

function formatTimestamp(value: string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
  }).format(new Date(value))
}

export function CommissionClearanceDetails({ rows }: { rows: BusinessOrderCommissionClearanceDetail[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<CommissionClearanceStatus | 'all'>('pending')
  const [salesperson, setSalesperson] = useState('all')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [withdrawingIds, setWithdrawingIds] = useState<string[] | null>(null)
  const [pending, startTransition] = useTransition()
  const [readingRejections, startReadTransition] = useTransition()
  const pendingCount = useMemo(() => rows.filter((row) => row.status === 'pending').length, [rows])
  const rejectedCount = useMemo(() => rows.filter((row) => row.status === 'rejected').length, [rows])
  const unreadRejectedCount = useMemo(
    () => rows.filter((row) => row.status === 'rejected' && !row.rejected_read_at).length,
    [rows],
  )
  const attentionCount = pendingCount + unreadRejectedCount
  const attentionBadge = attentionCount > 99 ? '99+' : attentionCount
  const salespeople = useMemo(
    () => [...new Set(rows.map((row) => row.salesperson_name))].sort((left, right) => left.localeCompare(right, 'zh-CN')),
    [rows],
  )
  const visibleRows = useMemo(
    () => rows.filter((row) =>
      (status === 'all' || row.status === status) &&
      (salesperson === 'all' || row.salesperson_name === salesperson)),
    [rows, salesperson, status],
  )
  const selectableRows = useMemo(
    () => visibleRows.filter((row) => row.status === 'pending'),
    [visibleRows],
  )
  const allSelected = selectableRows.length > 0 && selectableRows.every((row) => selectedIds.has(row.business_order_item_id))

  function toggleRow(id: string, checked: boolean) {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleSelectAll(checked: boolean) {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      for (const row of selectableRows) {
        if (checked) next.add(row.business_order_item_id)
        else next.delete(row.business_order_item_id)
      }
      return next
    })
  }

  function withdraw() {
    if (!withdrawingIds || withdrawingIds.length === 0) return
    startTransition(async () => {
      const result = await withdrawBusinessOrderCommissionClearance({
        business_order_item_ids: withdrawingIds,
      })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '撤回结清失败')
        return
      }
      toast.success(`已撤回 ${withdrawingIds.length} 条待确认结清`)
      setSelectedIds(new Set())
      setWithdrawingIds(null)
      router.refresh()
    })
  }

  function selectStatus(nextStatus: CommissionClearanceStatus | 'all') {
    setStatus(nextStatus)
    if (nextStatus !== 'rejected' || unreadRejectedCount === 0) return
    startReadTransition(async () => {
      const result = await markBusinessOrderCommissionRejectionsRead()
      if (!result.ok) {
        toast.error(result.error ?? '标记驳回记录已读失败')
        return
      }
      router.refresh()
    })
  }

  function statusButtonLabel(value: CommissionClearanceStatus | 'all', label: string) {
    if (value === 'pending') return `${label} ${pendingCount}`
    if (value === 'rejected') return `${label} ${rejectedCount}`
    return label
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" className="relative">
            <ListChecks className="mr-1.5 h-4 w-4" />
            结清确认明细
            {attentionCount > 0 && (
              <span className="absolute -right-2 -top-2 inline-flex min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-xs font-semibold leading-5 text-destructive-foreground">
                {attentionBadge}
              </span>
            )}
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-[calc(100vw-2rem)] lg:max-w-7xl">
          <DialogHeader>
            <DialogTitle>结清确认订单明细</DialogTitle>
            <p className="text-sm text-muted-foreground">按业务员查看已推送结清的产品行，以及确认或驳回结果。</p>
          </DialogHeader>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {([
                ['pending', '待确认'],
                ['confirmed', '已确认'],
                ['rejected', '已驳回'],
                ['all', '全部'],
              ] as const).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={status === value ? 'default' : 'outline'}
                  disabled={value === 'rejected' && readingRejections}
                  onClick={() => selectStatus(value)}
                >
                  {statusButtonLabel(value, label)}
                </Button>
              ))}
            </div>
            <select
              value={salesperson}
              onChange={(event) => setSalesperson(event.target.value)}
              className="h-9 rounded-md border bg-background px-3 text-sm"
              aria-label="按业务员筛选"
            >
              <option value="all">全部业务员</option>
              {salespeople.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-3 py-2">
            <span className="text-sm text-muted-foreground">已选 {selectedIds.size} 条待确认记录</span>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={selectedIds.size === 0}
              onClick={() => setWithdrawingIds([...selectedIds])}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              批量撤回
            </Button>
          </div>

          <Table className="min-w-[1220px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">
                  {selectableRows.length > 0 && (
                    <input
                      type="checkbox"
                      aria-label="全选待确认记录"
                      checked={allSelected}
                      onChange={(event) => toggleSelectAll(event.target.checked)}
                    />
                  )}
                </TableHead>
                <TableHead>业务员</TableHead>
                <TableHead>订单号</TableHead>
                <TableHead>产品</TableHead>
                <TableHead className="text-right">数量</TableHead>
                <TableHead>结清月份</TableHead>
                <TableHead>推送人 / 时间</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>确认 / 驳回结果</TableHead>
                <TableHead className="w-20">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row) => {
                const displayOrderNumber = row.external_order_number || row.order_number
                const isPending = row.status === 'pending'
                return (
                  <TableRow key={row.business_order_item_id}>
                    <TableCell>
                      {isPending && (
                        <input
                          type="checkbox"
                          aria-label={`选择 ${row.product_name}`}
                          checked={selectedIds.has(row.business_order_item_id)}
                          onChange={(event) => toggleRow(row.business_order_item_id, event.target.checked)}
                        />
                      )}
                    </TableCell>
                    <TableCell>{row.salesperson_name}</TableCell>
                    <TableCell className="font-medium">
                      <Link href={`/finance/daily-orders/${row.order_id}`} className="hover:underline">
                        {displayOrderNumber}
                      </Link>
                      {row.external_order_number && (
                        <div className="text-xs font-normal text-muted-foreground">{row.order_number}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div>{row.product_name}</div>
                      {row.product_sku && <div className="text-xs text-muted-foreground">{row.product_sku}</div>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.quantity.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}
                    </TableCell>
                    <TableCell className="tabular-nums">{row.period}</TableCell>
                    <TableCell>
                      <div>{row.submitted_by_name ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{formatTimestamp(row.submitted_at)}</div>
                    </TableCell>
                    <TableCell><Badge variant={statusVariant(row.status)}>{statusLabel(row.status)}</Badge></TableCell>
                    <TableCell>
                      {isPending ? (
                        <span className="text-sm text-muted-foreground">等待业务确认</span>
                      ) : row.status === 'confirmed' ? (
                        <>
                          <div>{row.confirmed_by_name ?? '—'}</div>
                          <div className="text-xs text-muted-foreground">{formatTimestamp(row.confirmed_at)}</div>
                        </>
                      ) : (
                        <div className="max-w-64 text-sm">{row.rejected_reason || '—'}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      {isPending && (
                        <Button type="button" size="sm" variant="outline" onClick={() => setWithdrawingIds([row.business_order_item_id])}>
                          <Trash2 className="mr-1 h-3.5 w-3.5" />
                          撤回
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
              {visibleRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">暂无对应结清记录</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>

      <Dialog open={withdrawingIds !== null} onOpenChange={(isOpen) => !isOpen && setWithdrawingIds(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>撤回待确认结清</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            撤回后，业务员将无法再确认所选产品行；这些产品行会恢复为可重新提交结清。
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setWithdrawingIds(null)}>取消</Button>
            <Button type="button" variant="destructive" disabled={pending} onClick={withdraw}>确认撤回</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
