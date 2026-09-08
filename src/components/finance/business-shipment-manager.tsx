'use client'

import { FormEvent, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { PackagePlus, Trash2, Truck } from 'lucide-react'
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
  createBusinessOrderShipment,
  voidBusinessOrderShipment,
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

interface BusinessShipmentManagerProps {
  order: Pick<
    BusinessOrder,
    'id' | 'status' | 'approval_status' | 'salesperson_id' | 'completion_gate_version'
  >
  profile: Pick<Profile, 'id' | 'role'>
  orderItems: BusinessOrderItem[]
  shipments: BusinessOrderShipment[]
  shipmentItems: BusinessOrderShipmentItem[]
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

export function BusinessShipmentManager({
  order,
  profile,
  orderItems,
  shipments,
  shipmentItems,
}: BusinessShipmentManagerProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [formOpen, setFormOpen] = useState(false)
  const [shippedAt, setShippedAt] = useState(getBusinessDateTimeLocal())
  const [trackingNumber, setTrackingNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const [voiding, setVoiding] = useState<BusinessOrderShipment | null>(null)
  const [voidReason, setVoidReason] = useState('')

  const activeShipmentIds = new Set(
    shipments.filter((shipment) => !shipment.voided_at).map((shipment) => shipment.id),
  )
  const shippedByOrderItem = shipmentItems.reduce<Record<string, number>>((totals, item) => {
    if (activeShipmentIds.has(item.shipment_id)) {
      totals[item.order_item_id] = (totals[item.order_item_id] ?? 0) + Number(item.quantity)
    }
    return totals
  }, {})
  const itemRows = orderItems.map((item) => {
    const total = Number(item.quantity)
    const shipped = shippedByOrderItem[item.id] ?? 0
    return { item, total, shipped, remaining: Math.max(0, total - shipped) }
  })

  const hasRemaining = itemRows.some((row) => row.remaining > 0)
  const hasRolePermission =
    (profile.role === 'admin' || profile.role === 'finance') ||
    ((profile.role === 'sales' || profile.role === 'supervisor') &&
      order.salesperson_id === profile.id)
  const canManage =
    hasRolePermission && order.status === 'approved' && order.approval_status === 'approved'
  const isLockedCompletedOrder = order.status === 'completed' && order.completion_gate_version >= 2
  const isLegacyCompletedOrder = order.status === 'completed' && order.completion_gate_version < 2
  const canVoid = canManage && !isLockedCompletedOrder

  function openCreateForm() {
    setShippedAt(getBusinessDateTimeLocal())
    setTrackingNumber('')
    setNotes('')
    setQuantities({})
    setIdempotencyKey(newUuid())
    setFormOpen(true)
  }

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const selectedItems = itemRows.flatMap(({ item, remaining }) => {
      const raw = quantities[item.id]?.trim()
      if (!raw) return []
      const quantity = Number(raw)
      return quantity > 0 ? [{ order_item_id: item.id, quantity, remaining }] : []
    })

    if (selectedItems.length === 0) {
      toast.error('请至少填写一项本次发货数量')
      return
    }
    const invalid = selectedItems.find(
      ({ quantity, remaining }) => !Number.isFinite(quantity) || quantity > remaining,
    )
    if (invalid) {
      toast.error('本次发货数量不能超过对应产品的剩余数量')
      return
    }
    if (!idempotencyKey) {
      toast.error('发货请求标识已失效，请关闭后重新打开表单')
      return
    }

    let shippedAtIso: string
    try {
      shippedAtIso = businessDateTimeLocalToIso(shippedAt)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '请选择有效发货时间')
      return
    }

    startTransition(async () => {
      const result = await createBusinessOrderShipment(order.id, {
        shipped_at: shippedAtIso,
        tracking_number: trackingNumber,
        notes,
        items: selectedItems.map(({ order_item_id, quantity }) => ({ order_item_id, quantity })),
        idempotency_key: idempotencyKey,
      })
      if (!result.ok) {
        toast.error(result.error ?? '创建发货批次失败')
        return
      }

      toast.success('发货批次已创建')
      setFormOpen(false)
      setQuantities({})
      setIdempotencyKey('')
      router.refresh()
    })
  }

  function handleVoid() {
    if (!voiding || !voidReason.trim()) return

    startTransition(async () => {
      const result = await voidBusinessOrderShipment(voiding.id, voidReason)
      if (!result.ok) {
        toast.error(result.error ?? '作废发货批次失败')
        return
      }

      toast.success('发货批次已作废')
      setVoiding(null)
      setVoidReason('')
      router.refresh()
    })
  }

  if (isLegacyCompletedOrder) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">发货管理</CardTitle></CardHeader>
        <CardContent>
          <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            此订单在新版发货追踪启用前已完成，历史逐产品发货批次未追溯；订单完成状态保持不变。
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="text-base">发货管理</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">按产品记录分批发货，作废批次不会计入已发数量。</p>
        </div>
        {canManage && hasRemaining && (
          <Button size="sm" onClick={openCreateForm}>
            <PackagePlus className="h-4 w-4" />新增发货
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <h3 className="text-sm font-medium">产品发货进度</h3>
          <div className="grid gap-2">
            {itemRows.map(({ item, total, shipped, remaining }) => (
              <div
                key={item.id}
                className="grid gap-2 rounded-md border p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center sm:gap-5"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{item.name_snapshot}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {item.sku_snapshot} · {item.specification_snapshot || item.unit_snapshot}
                  </div>
                </div>
                <div className="flex justify-between gap-3 sm:block sm:text-right">
                  <span className="text-muted-foreground sm:block">总数量</span>
                  <span className="font-medium tabular-nums">{formatQuantity(total)}</span>
                </div>
                <div className="flex justify-between gap-3 sm:block sm:text-right">
                  <span className="text-muted-foreground sm:block">有效已发</span>
                  <span className="font-medium tabular-nums">{formatQuantity(shipped)}</span>
                </div>
                <div className="flex justify-between gap-3 sm:block sm:text-right">
                  <span className="text-muted-foreground sm:block">剩余</span>
                  <span className="font-semibold tabular-nums">{formatQuantity(remaining)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">发货批次</h3>
          {shipments.map((shipment) => {
            const details = shipmentItems.filter((item) => item.shipment_id === shipment.id)
            return (
              <div key={shipment.id} className="rounded-md border p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex items-center gap-1.5 font-medium">
                        <Truck className="h-4 w-4 text-muted-foreground" />
                        {formatDate(shipment.shipped_at, true)}
                      </div>
                      {shipment.voided_at ? (
                        <Badge variant="secondary">已作废</Badge>
                      ) : (
                        <Badge variant="success">有效</Badge>
                      )}
                    </div>
                    <p className="break-all text-sm text-muted-foreground">
                      运单号：{shipment.tracking_number || '—'}
                    </p>
                    {shipment.notes && <p className="text-sm">备注：{shipment.notes}</p>}
                    {shipment.voided_at && (
                      <p className="text-sm text-destructive">作废原因：{shipment.void_reason || '—'}</p>
                    )}
                  </div>
                  {canVoid && !shipment.voided_at && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        setVoiding(shipment)
                        setVoidReason('')
                      }}
                    >
                      <Trash2 className="h-4 w-4" />作废批次
                    </Button>
                  )}
                </div>
                <div className="mt-3 grid gap-1 border-t pt-3 text-sm">
                  {details.map((detail) => {
                    const item = orderItems.find((candidate) => candidate.id === detail.order_item_id)
                    return (
                      <div key={detail.id} className="flex items-start justify-between gap-4">
                        <span className="min-w-0 break-words text-muted-foreground">
                          {item ? `${item.name_snapshot}（${item.sku_snapshot}）` : '订单产品'}
                        </span>
                        <span className="shrink-0 font-medium tabular-nums">
                          {formatQuantity(Number(detail.quantity))} {item?.unit_snapshot ?? ''}
                        </span>
                      </div>
                    )
                  })}
                  {details.length === 0 && <p className="text-muted-foreground">暂无批次明细</p>}
                </div>
              </div>
            )
          })}
          {shipments.length === 0 && (
            <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
              暂无发货批次
            </div>
          )}
        </div>
      </CardContent>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>新增发货批次</DialogTitle>
            <DialogDescription>只会提交数量大于 0 的产品，且本次数量不能超过剩余数量。</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleCreate}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="shipment_shipped_at">发货时间</Label>
                <Input
                  id="shipment_shipped_at"
                  type="datetime-local"
                  value={shippedAt}
                  onChange={(event) => setShippedAt(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="shipment_tracking_number">运单号</Label>
                <Input
                  id="shipment_tracking_number"
                  value={trackingNumber}
                  onChange={(event) => setTrackingNumber(event.target.value)}
                  maxLength={200}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>本次发货数量</Label>
              <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-2">
                {itemRows.map(({ item, remaining }) => (
                  <div
                    key={item.id}
                    className="grid gap-2 rounded-md bg-muted/40 p-2 sm:grid-cols-[minmax(0,1fr)_140px] sm:items-center"
                  >
                    <div className="min-w-0 text-sm">
                      <div className="truncate font-medium">{item.name_snapshot}</div>
                      <div className="text-xs text-muted-foreground">
                        剩余 {formatQuantity(remaining)} {item.unit_snapshot}
                      </div>
                    </div>
                    <Input
                      aria-label={`${item.name_snapshot}本次发货数量`}
                      type="number"
                      min="0.0001"
                      max={remaining}
                      step="0.0001"
                      inputMode="decimal"
                      value={quantities[item.id] ?? ''}
                      onChange={(event) =>
                        setQuantities((current) => ({ ...current, [item.id]: event.target.value }))
                      }
                      disabled={remaining <= 0}
                      placeholder={remaining > 0 ? '0' : '已发完'}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="shipment_notes">备注</Label>
              <Textarea
                id="shipment_notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                maxLength={1000}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? '创建中…' : '创建批次'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(voiding)} onOpenChange={(open) => !open && setVoiding(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>作废发货批次</DialogTitle>
            <DialogDescription>作废后该批次不再计入已发数量，此操作会保留审计记录。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="shipment_void_reason">作废原因</Label>
            <Textarea
              id="shipment_void_reason"
              value={voidReason}
              onChange={(event) => setVoidReason(event.target.value)}
              maxLength={1000}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setVoiding(null)}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending || !voidReason.trim() || isLockedCompletedOrder}
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
