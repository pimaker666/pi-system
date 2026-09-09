'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Star, Trash2, RotateCcw, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
import { PiDownloadMenu } from './pi-download-menu'
import { PiCloneButton } from './pi-clone-button'
import {
  bulkSoftDeletePi,
  restorePi,
  purgePi,
  toggleFavorite,
} from '@/lib/actions/pi'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import type { PiHistoryRow } from '@/types'
import type { OwnerOption } from '@/components/shared/owner-filter'

interface PiHistoryTableProps {
  rows: PiHistoryRow[]
  isAdmin: boolean
  view: 'active' | 'trash'
  owners: OwnerOption[]
}

export function PiHistoryTable({ rows, isAdmin, view, owners }: PiHistoryTableProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [delOpen, setDelOpen] = useState(false)
  const [purgeOpen, setPurgeOpen] = useState(false)

  // Optimistic favorite state overlay.
  const [favOverride, setFavOverride] = useState<Record<string, boolean>>({})
  const isFav = (row: PiHistoryRow) => favOverride[row.id] ?? row.is_favorite

  const ownerName = useMemo(() => new Map(owners.map((o) => [o.id, o.label])), [owners])
  const ownerLabel = (id: string | null, snapshot: string | null) =>
    snapshot?.trim() || (id ? ownerName.get(id) ?? '未知账号' : '—')

  const allChecked = rows.length > 0 && selected.size === rows.length
  const someChecked = selected.size > 0 && !allChecked
  const ids = useMemo(() => Array.from(selected), [selected])
  const colCount = 6 + (isAdmin ? 1 : 0)

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)))
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleFavorite(row: PiHistoryRow) {
    const next = !isFav(row)
    setFavOverride((prev) => ({ ...prev, [row.id]: next }))
    startTransition(async () => {
      const result = await toggleFavorite(row.id, next)
      if (!result.ok) {
        // revert on failure
        setFavOverride((prev) => ({ ...prev, [row.id]: !next }))
        toast.error(result.error ?? '操作失败')
      }
    })
  }

  function handleSoftDelete() {
    startTransition(async () => {
      const result = await bulkSoftDeletePi(ids)
      if (result.ok) {
        toast.success(`已移入回收站 ${ids.length} 项`)
        setDelOpen(false)
        setSelected(new Set())
        router.refresh()
      } else {
        toast.error(result.error ?? '删除失败')
      }
    })
  }

  function handleRestore() {
    startTransition(async () => {
      const result = await restorePi(ids)
      if (result.ok) {
        toast.success(`已恢复 ${ids.length} 项`)
        setSelected(new Set())
        router.refresh()
      } else {
        toast.error(result.error ?? '恢复失败')
      }
    })
  }

  function handlePurge() {
    startTransition(async () => {
      const result = await purgePi(ids)
      if (result.ok) {
        toast.success(`已彻底删除 ${ids.length} 项`)
        setPurgeOpen(false)
        setSelected(new Set())
        router.refresh()
      } else {
        toast.error(result.error ?? '删除失败')
      }
    })
  }

  return (
    <div className="space-y-3">
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-4 py-2">
          <span className="text-sm font-medium">已选 {selected.size} 项</span>
          <div className="ml-auto flex flex-wrap gap-2">
            {view === 'active' ? (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                onClick={() => setDelOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                批量删除
              </Button>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={handleRestore} disabled={pending}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  批量恢复
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive"
                  onClick={() => setPurgeOpen(true)}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  彻底删除
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              取消选择
            </Button>
          </div>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={allChecked}
                    ref={(el) => {
                      if (el) el.indeterminate = someChecked
                    }}
                    onChange={toggleAll}
                    aria-label="全选"
                  />
                </TableHead>
                <TableHead>PI 编号</TableHead>
                <TableHead>客户</TableHead>
                <TableHead className="text-right">金额</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>日期</TableHead>
                {isAdmin && <TableHead>归属账号</TableHead>}
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((pi) => (
                <TableRow key={pi.id} data-state={selected.has(pi.id) ? 'selected' : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={selected.has(pi.id)}
                      onChange={() => toggleOne(pi.id)}
                      aria-label={`选择 ${pi.pi_number}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Link href={`/pi/${pi.id}`} className="font-medium hover:underline">
                      {pi.pi_number}
                    </Link>
                  </TableCell>
                  <TableCell>{pi.customer_snapshot?.name ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(pi.total, pi.currency)}
                  </TableCell>
                  <TableCell>
                    {pi.status === 'void' ? (
                      <Badge variant="destructive">已作废</Badge>
                    ) : (
                      <Badge variant="success">有效</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(pi.created_at)}
                  </TableCell>
                  {isAdmin && (
                    <TableCell className="text-sm text-muted-foreground">
                      {ownerLabel(pi.created_by, pi.creator_display_name_snapshot)}
                    </TableCell>
                  )}
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title={isFav(pi) ? '取消收藏' : '收藏'}
                        onClick={() => handleFavorite(pi)}
                      >
                        <Star
                          className={cn(
                            'h-4 w-4',
                            isFav(pi)
                              ? 'fill-amber-400 text-amber-400'
                              : 'text-muted-foreground',
                          )}
                        />
                      </Button>
                      <PiDownloadMenu id={pi.id} compact />
                      <PiCloneButton id={pi.id} compact />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={colCount} className="py-10 text-center text-muted-foreground">
                    {view === 'trash' ? '回收站为空' : '没有匹配的 PI'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 批量软删除 */}
      <AlertDialog open={delOpen} onOpenChange={setDelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>将所选 {selected.size} 项移入回收站？</AlertDialogTitle>
            <AlertDialogDescription>
              移入回收站后可随时恢复，不会立即销毁数据。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleSoftDelete()
              }}
              disabled={pending}
            >
              {pending ? '处理中…' : '移入回收站'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 彻底删除 */}
      <AlertDialog open={purgeOpen} onOpenChange={setPurgeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>彻底删除所选 {selected.size} 项？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作不可撤销，PI 及其所有明细将被永久删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handlePurge()
              }}
              disabled={pending}
            >
              {pending ? '删除中…' : '彻底删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
