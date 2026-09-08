'use client'

import { FormEvent, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  createBusinessOrderReturn,
  voidBusinessOrderReturn,
} from '@/lib/actions/business-orders'
import {
  businessDateTimeLocalToIso,
  getBusinessDateTimeLocal,
} from '@/lib/business-orders'
import { formatDate } from '@/lib/utils'
import type {
  BusinessOrder,
  BusinessOrderItem,
  BusinessOrderShipment,
  BusinessOrderShipmentItem,
  Profile,
} from '@/types'

export interface BusinessOrderReturnItemView {
  id: string
  return_id?: string
  order_item_id: string
  shipment_item_id: string
  quantity: number
  created_at?: string
}

export interface BusinessOrderReturnView {
  id: string
  order_id: string
  returned_at: string
  reason?: string | null
  notes: string | null
  created_at: string
  voided_at: string | null
  void_reason: string | null
  business_order_return_items: BusinessOrderReturnItemView[]
}

interface BusinessReturnManagerProps {
  order: Pick<BusinessOrder, 'id' | 'status'> & { closed_at?: string | null }
  profile: Pick<Profile, 'role'>
  orderItems: BusinessOrderItem[]
  shipments: BusinessOrderShipment[]
  shipmentItems: BusinessOrderShipmentItem[]
  returns: BusinessOrderReturnView[]
}

function newUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16)
    const value = token === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

function formatQuantity(value: number) {
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 4 })
}

function roundQuantity(value: number) {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000
}

function encodeReturnNotes(reason: string, notes: string) {
  return [`退货原因：${reason.trim()}`, notes.trim() ? `备注：${notes.trim()}` : '']
    .filter(Boolean)
    .join('\n')
}

function decodeReturnNotes(value: string | null) {
  if (!value?.startsWith('退货原因：')) return { reason: null, notes: value }
  const [reasonLine, ...noteLines] = value.split('\n')
  const encodedNotes = noteLines.join('\n')
  return {
    reason: reasonLine.slice('退货原因：'.length).trim() || null,
    notes: encodedNotes.startsWith('备注：')
      ? encodedNotes.slice('备注：'.length).trim() || null
      : encodedNotes.trim() || null,
  }
}

export function BusinessReturnManager({
  order,
  profile,
  orderItems,
  shipments,
  shipmentItems,
  returns,
}: BusinessReturnManagerProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [formOpen, setFormOpen] = useState(false)
  const [returnedAt, setReturnedAt] = useState(getBusinessDateTimeLocal())
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const [voiding, setVoiding] = useState<BusinessOrderReturnView | null>(null)
  const [voidReason, setVoidReason] = useState('')

  const activeShipmentIds = useMemo(
    () => new Set(shipments.filter((shipment) => !shipment.voided_at).map((shipment) => shipment.id)),
    [shipments],
  )
  const activeReturns = useMemo(
    () => returns.filter((returnRecord) => !returnRecord.voided_at),
    [returns],
  )
  const activeReturnItems = useMemo(
    () => activeReturns.flatMap((returnRecord) => returnRecord.business_order_return_items ?? []),
    [activeReturns],
  )
  const itemRows = useMemo(
    () =>
      orderItems.map((item) => {
        const sources = shipmentItems
          .filter(
            (shipmentItem) =>
              shipmentItem.order_item_id === item.id &&
              activeShipmentIds.has(shipmentItem.shipment_id),
          )
          .map((shipmentItem) => {
            const returned = activeReturnItems.reduce(
              (sum, returnItem) =>
                returnItem.shipment_item_id === shipmentItem.id
                  ? sum + Number(returnItem.quantity)
                  : sum,
              0,
            )
            return {
              shipmentItemId: shipmentItem.id,
              shipped: Number(shipmentItem.quantity),
              returned,
              returnable: roundQuantity(
                Math.max(0, Number(shipmentItem.quantity) - returned),
              ),
            }
          })
        const shipped = sources.reduce((sum, source) => sum + source.shipped, 0)
        const returned = sources.reduce((sum, source) => sum + source.returned, 0)
        return {
          item,
          sources,
          shipped: roundQuantity(shipped),
          returned: roundQuantity(returned),
          returnable: roundQuantity(
            sources.reduce((sum, source) => sum + source.returnable, 0),
          ),
        }
      }),
    [activeReturnItems, activeShipmentIds, orderItems, shipmentItems],
  )

  const canManage =
    (profile.role === 'admin' || profile.role === 'finance') &&
    order.status === 'approved' &&
    !order.closed_at
  const hasReturnable = itemRows.some((row) => row.returnable > 0)

  function openCreateForm() {
    setReturnedAt(getBusinessDateTimeLocal())
    setReason('')
    setNotes('')
    setQuantities({})
    setIdempotencyKey(newUuid())
    setFormOpen(true)
  }

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const selectedItems = itemRows.flatMap(({ item, sources, returnable }) => {
      const raw = quantities[item.id]?.trim()
      if (!raw) return []
      const quantity = Number(raw)
      return quantity > 0 ? [{ item, sources, quantity, returnable }] : []
    })

    if (selectedItems.length === 0) {
      toast.error('请至少填写一项退货数量')
      return
    }
    if (selectedItems.some(({ quantity, returnable }) => !Number.isFinite(quantity) || quantity > returnable)) {
      toast.error('退货数量不能超过对应产品当前可退数量')
      return
    }
    if (!reason.trim()) {
      toast.error('请填写退货原因')
      return
    }

    const storedNotes = encodeReturnNotes(reason, notes)
    if (storedNotes.length > 1000) {
      toast.error('退货原因与备注合计不能超过 1000 字')
      return
    }

    const returnItems = selectedItems.flatMap(({ sources, quantity }) => {
      let remaining = roundQuantity(quantity)
      return sources.flatMap((source) => {
        if (remaining <= 0 || source.returnable <= 0) return []
        const returnedQuantity = roundQuantity(Math.min(remaining, source.returnable))
        remaining = roundQuantity(remaining - returnedQuantity)
        return [{ shipment_item_id: source.shipmentItemId, quantity: returnedQuantity }]
      })
    })

    let returnedAtIso: string
    try {
      returnedAtIso = businessDateTimeLocalToIso(returnedAt)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '请选择有效退货时间')
      return
    }

    startTransition(async () => {
      const result = await createBusinessOrderReturn(order.id, {
        returned_at: returnedAtIso,
        notes: storedNotes,
        items: returnItems,
        idempotency_key: idempotencyKey,
      })
      if (!result.ok) {
        toast.error(result.error ?? '登记退货失败')
        return
      }
      toast.success('退货已登记')
      setFormOpen(false)
      setQuantities({})
      setIdempotencyKey('')
      router.refresh()
    })
  }

  function handleVoid() {
    if (!voiding || !voidReason.trim()) return
    startTransition(async () => {
      const result = await voidBusinessOrderReturn(voiding.id, voidReason)
      if (!result.ok) {
        toast.error(result.error ?? '作废退货失败')
        return
      }
      toast.success('退货已作废')
      setVoiding(null)
      setVoidReason('')
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="text-base">退货管理</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            按产品登记部分退货；有效退货会减少净已发数量并保留完整审计事实。
          </p>
        </div>
        {canManage && hasReturnable && (
          <Button size="sm" onClick={openCreateForm}>
            <RotateCcw className="h-4 w-4" />登记退货
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {returns.map((returnRecord) => {
            const decoded = decodeReturnNotes(returnRecord.notes)
            const displayReason = returnRecord.reason?.trim() || decoded.reason
            const displayNotes = returnRecord.reason ? returnRecord.notes : decoded.notes
            return (
              <div key={returnRecord.id} className="rounded-md border p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{formatDate(returnRecord.returned_at, true)}</span>
                      <Badge variant={returnRecord.voided_at ? 'secondary' : 'success'}>
                        {returnRecord.voided_at ? '已作废' : '有效'}
                      </Badge>
                    </div>
                    {displayReason && <p className="text-sm">原因：{displayReason}</p>}
                    {displayNotes && (
                      <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                        备注：{displayNotes}
                      </p>
                    )}
                    {returnRecord.voided_at && (
                      <p className="text-sm text-destructive">作废原因：{returnRecord.void_reason || '—'}</p>
                    )}
                  </div>
                  {canManage && !returnRecord.voided_at && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        setVoiding(returnRecord)
                        setVoidReason('')
                      }}
                    >
                      <Trash2 className="h-4 w-4" />作废退货
                    </Button>
                  )}
                </div>
                <div className="mt-3 grid gap-1 border-t pt-3 text-sm">
                  {(returnRecord.business_order_return_items ?? []).map((returnItem) => {
                    const item = orderItems.find((candidate) => candidate.id === returnItem.order_item_id)
                    return (
                      <div key={returnItem.id} className="flex items-start justify-between gap-4">
                        <span className="min-w-0 break-words text-muted-foreground">
                          {item ? `${item.name_snapshot}（${item.sku_snapshot}）` : '订单产品'}
                        </span>
                        <span className="shrink-0 font-medium tabular-nums">
                          {formatQuantity(Number(returnItem.quantity))} {item?.unit_snapshot ?? ''}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
          {returns.length === 0 && (
            <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
              暂无退货记录
            </div>
          )}
        </div>
      </CardContent>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>登记业务订单退货</DialogTitle>
            <DialogDescription>可选择一个或多个已发货产品并填写部分退货数量。</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleCreate}>
            <div className="space-y-2">
              <Label htmlFor="return_returned_at">退货时间</Label>
              <Input
                id="return_returned_at"
                type="datetime-local"
                value={returnedAt}
                onChange={(event) => setReturnedAt(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>退货产品与数量</Label>
              <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-2">
                {itemRows.map(({ item, shipped, returned, returnable }) => (
                  <div
                    key={item.id}
                    className="grid gap-2 rounded-md bg-muted/40 p-2 sm:grid-cols-[minmax(0,1fr)_140px] sm:items-center"
                  >
                    <div className="min-w-0 text-sm">
                      <div className="truncate font-medium">{item.name_snapshot}</div>
                      <div className="text-xs text-muted-foreground">
                        已发 {formatQuantity(shipped)} · 已退 {formatQuantity(returned)} · 可退{' '}
                        {formatQuantity(returnable)} {item.unit_snapshot}
                      </div>
                    </div>
                    <Input
                      aria-label={`${item.name_snapshot}退货数量`}
                      type="number"
                      min="0.0001"
                      max={returnable}
                      step="0.0001"
                      inputMode="decimal"
                      value={quantities[item.id] ?? ''}
                      onChange={(event) =>
                        setQuantities((current) => ({ ...current, [item.id]: event.target.value }))
                      }
                      disabled={returnable <= 0}
                      placeholder={returnable > 0 ? '0' : '无可退数量'}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="return_reason">退货原因</Label>
              <Textarea
                id="return_reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="return_notes">备注</Label>
              <Textarea
                id="return_notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                maxLength={1000}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>取消</Button>
              <Button type="submit" disabled={pending || !reason.trim()}>
                {pending ? '登记中…' : '确认退货'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(voiding)} onOpenChange={(open) => !open && setVoiding(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>作废退货记录</DialogTitle>
            <DialogDescription>作废后退货数量会从累计退货中扣除，原记录与原因仍保留。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="return_void_reason">作废原因</Label>
            <Textarea
              id="return_void_reason"
              value={voidReason}
              onChange={(event) => setVoidReason(event.target.value)}
              maxLength={1000}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setVoiding(null)}>取消</Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending || !voidReason.trim()}
              onClick={handleVoid}
            >
              {pending ? '处理中…' : '确认作废'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
