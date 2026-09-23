'use client'

import Link from 'next/link'
import { useMemo, useState, useTransition } from 'react'
import { Trash2 } from 'lucide-react'
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
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { withdrawBusinessOrderCommissionClearance } from '@/lib/actions/commission'
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
  const [status, setStatus] = useState<CommissionClearanceStatus | 'all'>('pending')
  const [withdrawing, setWithdrawing] = useState<BusinessOrderCommissionClearanceDetail | null>(null)
  const [pending, startTransition] = useTransition()
  const visibleRows = useMemo(
    () => (status === 'all' ? rows : rows.filter((row) => row.status === status)),
    [rows, status],
  )

  function withdraw() {
    if (!withdrawing) return
    startTransition(async () => {
      const result = await withdrawBusinessOrderCommissionClearance({
        business_order_item_ids: [withdrawing.business_order_item_id],
      })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '撤回结清失败')
        return
      }
      toast.success('已撤回待确认结清')
      setWithdrawing(null)
      router.refresh()
    })
  }

  return (
    <section className="space-y-3 rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">结清确认订单明细</h2>
          <p className="text-sm text-muted-foreground">按业务员查看已推送结清的产品行，以及确认或驳回结果。</p>
        </div>
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
              onClick={() => setStatus(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      <Table className="min-w-[1180px]">
        <TableHeader>
          <TableRow>
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
            return (
              <TableRow key={row.business_order_item_id}>
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
                  {row.status === 'pending' ? (
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
                  {row.status === 'pending' && (
                    <Button type="button" size="sm" variant="outline" onClick={() => setWithdrawing(row)}>
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
              <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">暂无对应结清记录</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <Dialog open={withdrawing !== null} onOpenChange={(open) => !open && setWithdrawing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>撤回待确认结清</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            撤回后，业务员将无法再确认该产品行；该产品行会恢复为可重新提交结清。
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setWithdrawing(null)}>取消</Button>
            <Button type="button" variant="destructive" disabled={pending} onClick={withdraw}>确认撤回</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
