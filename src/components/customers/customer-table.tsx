'use client'

import { useMemo, useState, useTransition, type ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowDown, ArrowRightLeft, ArrowUp, ArrowUpDown, Copy, Pencil, Tags, Trash2 } from 'lucide-react'
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
import { CountryFlag } from '@/components/shared/country-flag'
import { formatCountryName } from '@/lib/country-flags'
import { formatDate } from '@/lib/utils'
import { formatCustomerTenure } from '@/lib/customer-tenure'
import {
  bulkTransferCustomers,
  bulkCopyCustomers,
  bulkDeleteCustomers,
  bulkModifyCustomers,
  bulkUpdateGroupCustomers,
} from '@/lib/actions/customers'
import type { Customer, CustomerGroup, CustomerCommissionTag } from '@/types'
import type { OwnerOption } from '@/components/shared/owner-filter'

export interface CustomerRow extends Customer {
  customer_groups: { name: string } | null
}

export interface CustomerOrderStats {
  lastYearAmountCny: number
  lastYearAmountUsd: number
  lastOrderDate: string | null
  customOrderCount: number
  firstOrderDate: string | null
  dealOrderCount: number
}

export type CustomerOrderStatsMap = Record<string, CustomerOrderStats>
export type CustomerSortField =
  | 'amount'
  | 'lastOrder'
  | 'createdAt'
  | 'tenure'
  | 'customOrderCount'
  | 'dealOrderCount'
export type CustomerSortDirection = 'asc' | 'desc'

const KEEP = '__keep__'
const NO_GROUP = '__none__'

const WHOLE_AMOUNT_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 })

function formatAmount(amount: number, currency: 'CNY' | 'USD') {
  return `${currency} ${WHOLE_AMOUNT_FORMAT.format(amount)}`
}

function twoLineLabel(first: string, second: string) {
  return (
    <span className="block text-center leading-tight">
      {first}
      <br />
      {second}
    </span>
  )
}

export function CustomerTable({
  customers,
  groups,
  owners = [],
  transferOwners = [],
  isAdmin = false,
  stats = {},
  customerTags = [],
  sortBy,
  sortDirection,
}: {
  customers: CustomerRow[]
  groups: CustomerGroup[]
  owners?: OwnerOption[]
  transferOwners?: OwnerOption[]
  isAdmin?: boolean
  stats?: CustomerOrderStatsMap
  customerTags?: CustomerCommissionTag[]
  sortBy: CustomerSortField
  sortDirection: CustomerSortDirection
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
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
  const colCount = isAdmin ? 14 : 13

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
        const count = result.count ?? ids.length
        toast.success(
          count === ids.length
            ? `已将 ${count} 个客户移入回收站`
            : `已将 ${count} 个客户移入回收站，其余无权限`,
        )
        setDelOpen(false)
        setSelected(new Set())
        router.refresh()
      } else {
        toast.error(result.error ?? '删除失败')
      }
    })
  }

  function toggleSort(field: CustomerSortField) {
    const params = new URLSearchParams(searchParams.toString())
    const nextDirection = sortBy === field && sortDirection === 'desc' ? 'asc' : 'desc'
    params.set('sortBy', field)
    params.set('sortDirection', nextDirection)
    router.push(`/customers?${params.toString()}`)
  }

  function sortableHeader(
    label: ReactNode,
    field: CustomerSortField,
    align: 'left' | 'right' | 'center' = 'left',
    title?: string,
    headClassName = '',
  ) {
    const Icon = sortBy === field ? (sortDirection === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
    return (
      <TableHead
        title={title}
        className={`sticky top-0 z-20 bg-background whitespace-nowrap shadow-sm ${align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : ''} ${headClassName}`}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`h-auto px-0 py-0 font-medium text-muted-foreground hover:bg-transparent hover:text-foreground ${align === 'right' ? 'ml-auto' : ''}`}
          onClick={() => toggleSort(field)}
        >
          {label}
          <Icon className="h-3.5 w-3.5" />
        </Button>
      </TableHead>
    )
  }

  return (
    <div className="space-y-3">
      {customerTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border bg-muted/30 px-4 py-2 text-sm">
          <span className="text-muted-foreground">客户标记说明：</span>
          {customerTags.map((tag) => (
            <span key={tag.tag_color} className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full border" style={{ backgroundColor: tag.tag_color }} />
              <span style={{ color: tag.tag_color }}>{tag.label}</span>
            </span>
          ))}
        </div>
      )}

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
              移入回收站
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              取消选择
            </Button>
          </div>
        </div>
      )}

      <Card className="min-w-[1660px]">
        <CardContent className="p-0">
          <Table containerClassName="overflow-visible">
            <TableHeader>
              <TableRow className="bg-background hover:bg-background">
                <TableHead className="sticky top-0 z-20 w-10 bg-background shadow-sm">
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
                <TableHead className="sticky top-0 z-20 w-[120px] bg-background pr-2 shadow-sm">客户</TableHead>
                <TableHead className="sticky top-0 z-20 w-[140px] bg-background pl-2 shadow-sm">公司</TableHead>
                <TableHead className="sticky top-0 z-20 w-[1%] whitespace-nowrap bg-background px-2 shadow-sm">国家</TableHead>
                <TableHead className="sticky top-0 z-20 w-[1%] whitespace-nowrap bg-background text-center shadow-sm">分组</TableHead>
                <TableHead className="sticky top-0 z-20 w-[1%] whitespace-nowrap bg-background px-2 text-center shadow-sm">联系方式</TableHead>
                {sortableHeader('近一年下单金额', 'amount', 'right', undefined, 'w-[1%]')}
                {sortableHeader('上次下单时间', 'lastOrder')}
                {sortableHeader(twoLineLabel('定制', '订单数'), 'customOrderCount', 'center', undefined, 'w-[1%]')}
                {sortableHeader(twoLineLabel('成交', '单数'), 'dealOrderCount', 'center', '只含现货样品或定制打样的订单不计入', 'w-[1%]')}
                {sortableHeader(twoLineLabel('客户', '年限'), 'tenure', 'center', '从第一次下单起算，按自然月折算（6个月=0.5年），每月1号统一更新', 'w-[1%]')}
                {sortableHeader('新建客户时间', 'createdAt')}
                {isAdmin && <TableHead className="sticky top-0 z-20 whitespace-nowrap bg-background shadow-sm">归属账号</TableHead>}
                <TableHead className="sticky top-0 z-20 bg-background text-right shadow-sm">操作</TableHead>
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
                  <TableCell className="pr-2 font-medium" style={{ color: c.tag_color ?? undefined }}>
                    <button
                      type="button"
                      className="block w-full cursor-pointer whitespace-normal break-words text-left leading-snug hover:underline"
                      onClick={() => window.open(`/customers/${c.id}`, '_blank', 'noopener,noreferrer')}
                    >
                      {c.name}
                    </button>
                  </TableCell>
                  <TableCell className="pl-2">
                    <span className="block whitespace-normal break-words leading-snug">
                      {c.company ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-2">
                    <span className="flex items-center gap-1.5">
                      <CountryFlag country={c.country} />
                      {formatCountryName(c.country)}
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    {c.customer_groups ? (
                      <Badge variant="secondary" className="whitespace-nowrap">
                        {c.customer_groups.name}
                      </Badge>
                    ) : (
                      <span className="whitespace-nowrap text-muted-foreground">未分组</span>
                    )}
                  </TableCell>
                  <TableCell className="px-2 text-center text-sm text-muted-foreground">
                    <span className="mx-auto block max-w-[110px] truncate" title={c.email ?? c.phone ?? undefined}>
                      {c.email ?? c.phone ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {stats[c.id]?.lastYearAmountCny || stats[c.id]?.lastYearAmountUsd ? (
                      <div className="space-y-0.5 whitespace-nowrap">
                        {stats[c.id]?.lastYearAmountCny ? (
                          <div>{formatAmount(stats[c.id].lastYearAmountCny, 'CNY')}</div>
                        ) : null}
                        {stats[c.id]?.lastYearAmountUsd ? (
                          <div>{formatAmount(stats[c.id].lastYearAmountUsd, 'USD')}</div>
                        ) : null}
                      </div>
                    ) : '—'}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground tabular-nums">
                    {stats[c.id]?.lastOrderDate ?? '—'}
                  </TableCell>
                  <TableCell className="text-center tabular-nums">
                    {stats[c.id]?.customOrderCount ?? 0}
                  </TableCell>
                  <TableCell className="text-center tabular-nums">
                    {stats[c.id]?.dealOrderCount ?? 0}
                  </TableCell>
                  <TableCell className="text-center tabular-nums whitespace-nowrap">
                    {formatCustomerTenure(stats[c.id]?.firstOrderDate)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground tabular-nums whitespace-nowrap">
                    {formatDate(c.created_at)}
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
                      customerTags={customerTags}
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

      {/* 批量移入回收站 */}
      <AlertDialog open={delOpen} onOpenChange={setDelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>将所选 {selected.size} 个客户移入回收站？</AlertDialogTitle>
            <AlertDialogDescription>
              客户会先从客户列表、订单绑定和 PI 选择中隐藏，历史订单与 PI 保持不变；可在「回收站」恢复或彻底删除。
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
              {pending ? '处理中…' : '移入回收站'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
