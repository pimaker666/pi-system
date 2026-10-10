'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { RotateCcw, Trash2 } from 'lucide-react'
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
import { CountryFlag } from '@/components/shared/country-flag'
import { formatCountryName } from '@/lib/country-flags'
import { formatDate } from '@/lib/utils'
import { purgeCustomers, restoreCustomers } from '@/lib/actions/customers'
import type { CustomerRow } from './customer-table'
import type { OwnerOption } from '@/components/shared/owner-filter'

const PURGE_HINT =
  '彻底删除后不可恢复。该客户的订单与 PI 会解绑，只保留名称快照；存在定制产品档案或收款转账记录的客户会被拒绝删除。'

export function CustomerRecycleBin({
  customers,
  owners = [],
  isAdmin = false,
}: {
  customers: CustomerRow[]
  owners?: OwnerOption[]
  isAdmin?: boolean
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, startTransition] = useTransition()
  const [bulkPurgeOpen, setBulkPurgeOpen] = useState(false)
  const [purgeTarget, setPurgeTarget] = useState<CustomerRow | null>(null)

  const ownerName = useMemo(() => new Map(owners.map((o) => [o.id, o.label])), [owners])
  const ids = useMemo(() => Array.from(selected), [selected])
  const colCount = isAdmin ? 7 : 6

  const allChecked = customers.length > 0 && selected.size === customers.length
  const someChecked = selected.size > 0 && !allChecked

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(customers.map((c) => c.id)))
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function runRestore(targetIds: string[]) {
    startTransition(async () => {
      const result = await restoreCustomers(targetIds)
      if (!result.ok) {
        toast.error(result.error ?? '恢复失败')
        return
      }
      const count = result.count ?? targetIds.length
      toast.success(
        count === targetIds.length
          ? `已恢复 ${count} 个客户`
          : `已恢复 ${count} 个客户，其余不在回收站或无权限`,
      )
      setSelected((prev) => {
        const next = new Set(prev)
        for (const id of targetIds) next.delete(id)
        return next
      })
      router.refresh()
    })
  }

  function runPurge(targetIds: string[]) {
    startTransition(async () => {
      const result = await purgeCustomers(targetIds)
      if (!result.ok) {
        toast.error(result.error ?? '彻底删除失败')
        return
      }
      const count = result.count ?? targetIds.length
      toast.success(
        count === targetIds.length
          ? `已彻底删除 ${count} 个客户`
          : `已彻底删除 ${count} 个客户，其余不在回收站或无权限`,
      )
      setBulkPurgeOpen(false)
      setPurgeTarget(null)
      setSelected((prev) => {
        const next = new Set(prev)
        for (const id of targetIds) next.delete(id)
        return next
      })
      router.refresh()
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        回收站中的客户不会出现在客户列表、订单绑定和 PI 选择中，可随时恢复。
      </p>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-4 py-2">
          <span className="text-sm font-medium">已选 {selected.size} 项</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => runRestore(ids)} disabled={pending}>
              <RotateCcw className="h-3.5 w-3.5" />
              恢复
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={() => setBulkPurgeOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              彻底删除
            </Button>
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
                <TableHead>客户</TableHead>
                <TableHead>公司</TableHead>
                <TableHead>国家</TableHead>
                <TableHead className="whitespace-nowrap">分组</TableHead>
                {isAdmin && <TableHead className="whitespace-nowrap">归属账号</TableHead>}
                <TableHead className="whitespace-nowrap">删除时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((c) => (
                <TableRow key={c.id} data-state={selected.has(c.id) ? 'selected' : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={selected.has(c.id)}
                      onChange={() => toggleOne(c.id)}
                      aria-label={`选择 ${c.name}`}
                    />
                  </TableCell>
                  <TableCell className="font-medium" style={{ color: c.tag_color ?? undefined }}>
                    {c.name}
                  </TableCell>
                  <TableCell>{c.company ?? '—'}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <CountryFlag country={c.country} />
                      {formatCountryName(c.country)}
                    </span>
                  </TableCell>
                  <TableCell>
                    {c.customer_groups ? (
                      <Badge variant="secondary">{c.customer_groups.name}</Badge>
                    ) : (
                      <span className="text-muted-foreground">未分组</span>
                    )}
                  </TableCell>
                  {isAdmin && (
                    <TableCell className="text-sm text-muted-foreground">
                      {c.created_by ? ownerName.get(c.created_by) ?? '未知账号' : '—'}
                    </TableCell>
                  )}
                  <TableCell className="text-sm text-muted-foreground tabular-nums whitespace-nowrap">
                    {c.deleted_at ? formatDate(c.deleted_at) : '—'}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="恢复客户"
                        disabled={pending}
                        onClick={() => runRestore([c.id])}
                      >
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        title="彻底删除"
                        onClick={() => setPurgeTarget(c)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {customers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={colCount} className="py-10 text-center text-muted-foreground">
                    回收站是空的
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AlertDialog open={bulkPurgeOpen} onOpenChange={setBulkPurgeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>彻底删除所选 {selected.size} 个客户？</AlertDialogTitle>
            <AlertDialogDescription>{PURGE_HINT}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                runPurge(ids)
              }}
              disabled={pending}
            >
              {pending ? '删除中…' : '彻底删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={purgeTarget !== null} onOpenChange={(open) => !open && setPurgeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>彻底删除客户「{purgeTarget?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>{PURGE_HINT}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                if (purgeTarget) runPurge([purgeTarget.id])
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
