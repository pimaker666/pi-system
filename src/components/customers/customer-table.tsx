'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRightLeft, Copy, Pencil, Tags, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { CustomerRowActions } from './customer-row-actions'
import {
  bulkTransferCustomers,
  bulkCopyCustomers,
  bulkDeleteCustomers,
  bulkModifyCustomers,
  bulkUpdateGroupCustomers,
} from '@/lib/actions/customers'
import type { Customer, CustomerGroup } from '@/types'
import type { OwnerOption } from '@/components/shared/owner-filter'

export interface CustomerRow extends Customer {
  customer_groups: { name: string } | null
}

const KEEP = '__keep__'
const NO_GROUP = '__none__'

export function CustomerTable({
  customers,
  groups,
  owners = [],
  transferOwners = [],
  isAdmin = false,
}: {
  customers: CustomerRow[]
  groups: CustomerGroup[]
  owners?: OwnerOption[]
  transferOwners?: OwnerOption[]
  isAdmin?: boolean
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, startTransition] = useTransition()

  const [moveOpen, setMoveOpen] = useState(false)
  const [moveMode, setMoveMode] = useState<'transfer' | 'copy'>('transfer')
  const [targetId, setTargetId] = useState('')
  const [delOpen, setDelOpen] = useState(false)

  // 批量修改
  const [editOpen, setEditOpen] = useState(false)
  const [mCountry, setMCountry] = useState('')
  const [mCompany, setMCompany] = useState('')
  const [mContact, setMContact] = useState('')
  const [mOwner, setMOwner] = useState<string>(KEEP)

  // 批量调整分组
  const [groupOpen, setGroupOpen] = useState(false)
  const [groupTarget, setGroupTarget] = useState('')

  const ownerName = useMemo(() => new Map(owners.map((o) => [o.id, o.label])), [owners])
  const ownerLabel = (id: string | null) => (id ? ownerName.get(id) ?? '未知账号' : '—')

  const allChecked = customers.length > 0 && selected.size === customers.length
  const someChecked = selected.size > 0 && !allChecked
  const ids = useMemo(() => Array.from(selected), [selected])
  const colCount = isAdmin ? 8 : 7

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

  function openMove(mode: 'transfer' | 'copy') {
    setMoveMode(mode)
    setTargetId('')
    setMoveOpen(true)
  }

  function handleMove() {
    if (!targetId) {
      toast.error('请选择目标账号')
      return
    }
    startTransition(async () => {
      const result =
        moveMode === 'transfer'
          ? await bulkTransferCustomers(ids, targetId)
          : await bulkCopyCustomers(ids, targetId)
      if (result.ok) {
        toast.success(
          moveMode === 'transfer'
            ? `已转移 ${ids.length} 个客户，历史 PI 保持不变`
            : `已复制 ${ids.length} 个客户`,
        )
        setMoveOpen(false)
        setSelected(new Set())
        router.refresh()
      } else {
        toast.error(result.error ?? '操作失败')
      }
    })
  }

  function openEdit() {
    setMCountry('')
    setMCompany('')
    setMContact('')
    setMOwner(KEEP)
    setEditOpen(true)
  }

  function handleModify() {
    const patch = {
      country: mCountry.trim(),
      company: mCompany.trim(),
      contact_person: mContact.trim(),
      created_by: mOwner === KEEP ? '' : mOwner,
    }
    if (!patch.country && !patch.company && !patch.contact_person && !patch.created_by) {
      toast.error('请至少填写一个要修改的字段')
      return
    }
    startTransition(async () => {
      const result = await bulkModifyCustomers(ids, patch)
      if (result.ok) {
        toast.success(`已修改 ${ids.length} 个客户`)
        setEditOpen(false)
        setSelected(new Set())
        router.refresh()
      } else {
        toast.error(result.error ?? '修改失败')
      }
    })
  }

  function openGroup() {
    setGroupTarget('')
    setGroupOpen(true)
  }

  function handleGroup() {
    if (!groupTarget) {
      toast.error('请选择目标分组')
      return
    }
    const groupId = groupTarget === NO_GROUP ? null : groupTarget
    startTransition(async () => {
      const result = await bulkUpdateGroupCustomers(ids, groupId)
      if (result.ok) {
        toast.success(`已调整 ${ids.length} 个客户的分组`)
        setGroupOpen(false)
        setSelected(new Set())
        router.refresh()
      } else {
        toast.error(result.error ?? '调整分组失败')
      }
    })
  }

  function handleDelete() {
    startTransition(async () => {
      const result = await bulkDeleteCustomers(ids)
      if (result.ok) {
        toast.success(`已删除 ${ids.length} 个客户`)
        setDelOpen(false)
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
            <Button size="sm" variant="outline" onClick={openEdit}>
              <Pencil className="h-3.5 w-3.5" />
              修改
            </Button>
            <Button size="sm" variant="outline" onClick={openGroup}>
              <Tags className="h-3.5 w-3.5" />
              调整分组
            </Button>
            {transferOwners.length > 0 && (
              <>
                <Button size="sm" variant="outline" onClick={() => openMove('transfer')}>
                  <ArrowRightLeft className="h-3.5 w-3.5" />
                  转移
                </Button>
                <Button size="sm" variant="outline" onClick={() => openMove('copy')}>
                  <Copy className="h-3.5 w-3.5" />
                  复制
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={() => setDelOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除
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
                <TableHead>分组</TableHead>
                <TableHead>联系方式</TableHead>
                {isAdmin && <TableHead>归属账号</TableHead>}
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
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>{c.company ?? '—'}</TableCell>
                  <TableCell>{c.country ?? '—'}</TableCell>
                  <TableCell>
                    {c.customer_groups ? (
                      <Badge variant="secondary">{c.customer_groups.name}</Badge>
                    ) : (
                      <span className="text-muted-foreground">未分组</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {c.email ?? c.phone ?? '—'}
                  </TableCell>
                  {isAdmin && (
                    <TableCell className="text-sm text-muted-foreground">
                      {ownerLabel(c.created_by)}
                    </TableCell>
                  )}
                  <TableCell>
                    <CustomerRowActions
                      customer={c}
                      groups={groups}
                      isAdmin={isAdmin}
                      owners={transferOwners}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {customers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={colCount} className="py-10 text-center text-muted-foreground">
                    没有符合条件的客户
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 批量修改 */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>批量修改（{selected.size} 项）</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>国家</Label>
              <Input
                value={mCountry}
                onChange={(e) => setMCountry(e.target.value)}
                placeholder="留空则不修改"
              />
            </div>
            <div className="space-y-1.5">
              <Label>公司</Label>
              <Input
                value={mCompany}
                onChange={(e) => setMCompany(e.target.value)}
                placeholder="留空则不修改"
              />
            </div>
            <div className="space-y-1.5">
              <Label>联系人</Label>
              <Input
                value={mContact}
                onChange={(e) => setMContact(e.target.value)}
                placeholder="留空则不修改"
              />
            </div>
            {transferOwners.length > 0 && (
              <div className="space-y-1.5">
                <Label>归属账号</Label>
                <Select value={mOwner} onValueChange={setMOwner}>
                  <SelectTrigger>
                    <SelectValue placeholder="不修改" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={KEEP}>不修改</SelectItem>
                    {transferOwners.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  仅改变客户当前负责人；历史 PI 的归属与创建人保持不变。
                </p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              只会更新你填写了值的字段，留空的字段保持每个客户原值不变。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button onClick={handleModify} disabled={pending}>
              {pending ? '处理中…' : '确定'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量调整分组 */}
      <Dialog open={groupOpen} onOpenChange={setGroupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>批量调整分组（{selected.size} 项）</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>目标分组</Label>
            <Select value={groupTarget} onValueChange={setGroupTarget}>
              <SelectTrigger>
                <SelectValue placeholder="选择分组" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_GROUP}>未分组</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              所选客户将统一归入该分组；选择「未分组」则清除现有分组。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGroupOpen(false)}>
              取消
            </Button>
            <Button onClick={handleGroup} disabled={pending}>
              {pending ? '处理中…' : '确定'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量转移 / 复制 */}
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {moveMode === 'transfer' ? '批量转移' : '批量复制'}（{selected.size} 项）
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>目标账号</Label>
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger>
                <SelectValue placeholder="选择账号" />
              </SelectTrigger>
              <SelectContent>
                {transferOwners.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {moveMode === 'transfer'
                ? '转移只改变这些客户的当前负责人；历史 PI 的归属与创建人保持不变。'
                : '复制会为所选账号新建相同客户信息，不复制 PI。'}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveOpen(false)}>
              取消
            </Button>
            <Button onClick={handleMove} disabled={pending}>
              {pending ? '处理中…' : '确定'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量删除 */}
      <AlertDialog open={delOpen} onOpenChange={setDelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除所选 {selected.size} 个客户？</AlertDialogTitle>
            <AlertDialogDescription>
              已生成的 PI 会保留客户信息快照，不受影响。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleDelete()
              }}
              disabled={pending}
            >
              {pending ? '删除中…' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
