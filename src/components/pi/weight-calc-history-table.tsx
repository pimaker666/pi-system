'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { Download, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
import { deleteWeightCalc } from '@/lib/actions/weight'
import { formatDate } from '@/lib/utils'
import type { WeightCalcHistoryRow } from '@/types'
import type { OwnerOption } from '@/components/shared/owner-filter'

interface Props {
  rows: WeightCalcHistoryRow[]
  isAdmin: boolean
  owners: OwnerOption[]
}

/** KG string with up to 3 decimals from a gram total. */
function gToKg(grams: number): string {
  return (Number(grams) / 1000).toLocaleString('en-US', {
    maximumFractionDigits: 3,
  })
}

function fmtNum(n: number): string {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })
}

export function WeightCalcHistoryTable({ rows, isAdmin, owners }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [target, setTarget] = useState<WeightCalcHistoryRow | null>(null)

  const ownerName = new Map(owners.map((o) => [o.id, o.label]))
  const ownerLabel = (id: string | null) =>
    id ? ownerName.get(id) ?? '未知账号' : '—'

  function confirmDelete() {
    if (!target) return
    const row = target
    startTransition(async () => {
      try {
        await deleteWeightCalc(row.id)
        toast.success(`已删除 ${row.calc_number}`)
        setTarget(null)
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '删除失败')
      }
    })
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
        还没有保存的克重计算单。在「计算重量」页生成后点击「保存到历史」即可。
      </p>
    )
  }

  return (
    <>
      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-md border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>编号</TableHead>
              <TableHead>标题</TableHead>
              <TableHead className="text-right">总数量</TableHead>
              <TableHead className="text-right">总重量 (KG)</TableHead>
              {isAdmin && <TableHead>创建人</TableHead>}
              <TableHead>创建时间</TableHead>
              <TableHead className="w-28 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/weight-calc/${row.id}`}
                    className="hover:underline"
                  >
                    {row.calc_number}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {row.title || '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmtNum(row.total_quantity)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {gToKg(row.total_weight_g)}
                </TableCell>
                {isAdmin && (
                  <TableCell className="text-muted-foreground">
                    {row.creator_display_name_snapshot?.trim() || ownerLabel(row.created_by)}
                  </TableCell>
                )}
                <TableCell className="text-muted-foreground">
                  {formatDate(row.created_at)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title="下载 Excel"
                      asChild
                    >
                      <a href={`/api/weight-calc/${row.id}/xlsx`}>
                        <Download className="h-4 w-4" />
                      </a>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      title="删除"
                      onClick={() => setTarget(row)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {rows.map((row) => (
          <Card key={row.id}>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-center justify-between">
                <Link
                  href={`/weight-calc/${row.id}`}
                  className="font-medium hover:underline"
                >
                  {row.calc_number}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {formatDate(row.created_at)}
                </span>
              </div>
              {row.title && <div className="text-sm">{row.title}</div>}
              <div className="flex gap-4 text-sm text-muted-foreground">
                <span>总数量 {fmtNum(row.total_quantity)}</span>
                <span>总重量 {gToKg(row.total_weight_g)} KG</span>
              </div>
              {isAdmin && (
                <div className="text-xs text-muted-foreground">
                  创建人：{row.creator_display_name_snapshot?.trim() || ownerLabel(row.created_by)}
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <Button variant="outline" size="sm" asChild>
                  <a href={`/api/weight-calc/${row.id}/xlsx`}>
                    <Download className="mr-1 h-4 w-4" />
                    下载
                  </a>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setTarget(row)}
                >
                  <Trash2 className="mr-1 h-4 w-4" />
                  删除
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <AlertDialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除克重计算单？</AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除 {target?.calc_number} 及其明细，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                confirmDelete()
              }}
              disabled={pending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pending ? '删除中…' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
