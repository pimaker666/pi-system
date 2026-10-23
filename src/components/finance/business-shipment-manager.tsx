'use client'

import { FormEvent, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, PackagePlus, Trash2, Truck, X } from 'lucide-react'
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
  getBusinessOrderShipmentScreenshotUrl,
  voidBusinessOrderShipment,
} from '@/lib/actions/business-orders'
import { createClient } from '@/lib/supabase/client'
import {
  businessDateTimeLocalToIso,
  getBusinessDateTimeLocal,
} from '@/lib/business-orders'
import {
  businessOrderItemDisplayName,
  businessOrderItemDisplaySku,
} from '@/lib/business-order-financials'
import { useFileDrop, useFilePaste } from '@/lib/hooks/use-file-drop'
import { formatDate, formatAmount } from '@/lib/utils'
import type {
  BusinessOrder,
  BusinessOrderItem,
  BusinessOrderShipment,
  BusinessOrderShipmentItem,
} from '@/types'

interface BusinessShipmentManagerProps {
  profileId: string
  order: Pick<
    BusinessOrder,
    'id' | 'status' | 'approval_status' | 'salesperson_id' | 'completion_gate_version'
  > & { closed_at?: string | null; voided_at?: string | null }
  canShip: boolean
  orderItems: BusinessOrderItem[]
  shipments: BusinessOrderShipment[]
  shipmentItems: BusinessOrderShipmentItem[]
  returns?: Array<{ id: string; voided_at: string | null }>
  returnItems?: Array<{ return_id?: string; order_return_id?: string; order_item_id: string; quantity: number }>
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
  return formatAmount(Number(value))
}

export function BusinessShipmentManager({
  profileId,
  order,
  canShip,
  orderItems,
  shipments,
  shipmentItems,
  returns = [],
  returnItems = [],
}: BusinessShipmentManagerProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [formOpen, setFormOpen] = useState(false)
  const [shippedAt, setShippedAt] = useState(getBusinessDateTimeLocal())
  const [trackingNumber, setTrackingNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [wholeOrderShipment, setWholeOrderShipment] = useState(false)
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const [screenshotItems, setScreenshotItems] = useState<
    Array<{ file: File; previewUrl: string }>
  >([])
  const [viewingScreenshotUrls, setViewingScreenshotUrls] = useState<string[] | null>(null)
  const [voiding, setVoiding] = useState<BusinessOrderShipment | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const {
    dragging: screenshotDragging,
    dropProps: screenshotDropProps,
  } = useFileDrop({ onFile: (file) => addScreenshotFiles([file]) })
  const { pasteRef: screenshotPasteRef } = useFilePaste({
    onFiles: (files) => addScreenshotFiles(files),
  })

  const activeShipmentIds = new Set(
    shipments.filter((shipment) => !shipment.voided_at).map((shipment) => shipment.id),
  )
  const shippedByOrderItem = shipmentItems.reduce<Record<string, number>>((totals, item) => {
    if (activeShipmentIds.has(item.shipment_id)) {
      totals[item.order_item_id] = (totals[item.order_item_id] ?? 0) + Number(item.quantity)
    }
    return totals
  }, {})
  const activeReturnIds = new Set(
    returns.filter((returnRecord) => !returnRecord.voided_at).map((returnRecord) => returnRecord.id),
  )
  const returnedByOrderItem = returnItems.reduce<Record<string, number>>((totals, item) => {
    const returnId = item.return_id ?? item.order_return_id
    if (returnId && activeReturnIds.has(returnId)) {
      totals[item.order_item_id] = (totals[item.order_item_id] ?? 0) + Number(item.quantity)
    }
    return totals
  }, {})
  const itemRows = orderItems.map((item) => {
    const total = Number(item.quantity)
    const shipped = shippedByOrderItem[item.id] ?? 0
    const returned = returnedByOrderItem[item.id] ?? 0
    const netShipped = Math.max(0, shipped - returned)
    return { item, total, shipped, returned, netShipped, remaining: Math.max(0, total - netShipped) }
  })

  const hasRemaining = itemRows.some((row) => row.remaining > 0)
  const canManage =
    canShip &&
    !order.closed_at &&
    !order.voided_at &&
    order.status === 'approved' &&
    order.approval_status === 'approved'
  const isLockedCompletedOrder = order.status === 'completed' && order.completion_gate_version >= 2
  const isLegacyCompletedOrder = order.status === 'completed' && order.completion_gate_version < 2
  const canVoid = canManage && !isLockedCompletedOrder

  function addScreenshotFiles(files: File[]) {
    setScreenshotItems((current) => {
      const next = [...current]
      for (const file of files) {
        if (next.length >= 10) {
          toast.error('发货截图最多 10 张')
          break
        }
        if (!['image/jpeg', 'image/png'].includes(file.type)) {
          toast.error(`「${file.name}」仅支持 JPG 或 PNG 图片`)
          continue
        }
        if (file.size > 20 * 1024 * 1024) {
          toast.error(`「${file.name}」超过 20MB`)
          continue
        }
        next.push({ file, previewUrl: URL.createObjectURL(file) })
      }
      return next
    })
  }

  function removeScreenshotItem(index: number) {
    setScreenshotItems((current) => {
      current[index]?.previewUrl && URL.revokeObjectURL(current[index].previewUrl)
      return current.filter((_, itemIndex) => itemIndex !== index)
    })
  }

  function clearScreenshotItems(items: Array<{ file: File; previewUrl: string }>) {
    for (const item of items) URL.revokeObjectURL(item.previewUrl)
  }

  async function uploadScreenshotFiles(): Promise<string[]> {
    if (!idempotencyKey || screenshotItems.length === 0) return []
    const bucket = createClient().storage.from('business-shipment-screenshots')
    const paths: string[] = []
    for (let index = 0; index < screenshotItems.length; index += 1) {
      const screenshotFile = screenshotItems[index].file
      const extension = screenshotFile.name.split('.').pop()?.toLowerCase() ?? 'png'
      // 首张沿用幂等键命名；附加截图用随机 uuid 命名以满足存储桶的 uuid.ext 策略。
      const fileName =
        index === 0 ? `${idempotencyKey}.${extension}` : `${newUuid()}.${extension}`
      const folder = `${profileId}/${order.id}`
      const path = `${folder}/${fileName}`
      const { error } = await bucket.upload(path, screenshotFile, {
        contentType: screenshotFile.type,
        upsert: false,
      })
      if (error) {
        const { data: existing, error: listError } = await bucket.list(folder, {
          limit: 100,
          search: fileName,
        })
        if (listError || !existing?.some((item) => item.name === fileName)) {
          throw new Error(error.message)
        }
      }
      paths.push(path)
    }
    return paths
  }

  function viewShipmentScreenshot(shipmentId: string) {
    startTransition(async () => {
      const result = await getBusinessOrderShipmentScreenshotUrl(shipmentId)
      if (result.urls && result.urls.length > 0) setViewingScreenshotUrls(result.urls)
      else toast.error(result.error ?? '无法查看发货截图')
    })
  }

  function openCreateForm(wholeOrder = false) {
    setShippedAt(getBusinessDateTimeLocal())
    setTrackingNumber('')
    setNotes('')
    setWholeOrderShipment(wholeOrder)
    clearScreenshotItems(screenshotItems)
    setScreenshotItems([])
    setQuantities(
      wholeOrder
        ? Object.fromEntries(
            itemRows
              .filter((row) => row.remaining > 0)
              .map((row) => [row.item.id, String(row.remaining)]),
          )
        : {},
    )
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
      let screenshotPaths: string[] = []
      if (screenshotItems.length > 0) {
        try {
          screenshotPaths = await uploadScreenshotFiles()
        } catch (error) {
          toast.error(error instanceof Error ? error.message : '发货截图上传失败，请重试')
          return
        }
      }

      const result = await createBusinessOrderShipment(order.id, {
        shipped_at: shippedAtIso,
        tracking_number: trackingNumber,
        notes,
        items: selectedItems.map(({ order_item_id, quantity }) => ({ order_item_id, quantity })),
        idempotency_key: idempotencyKey,
        screenshot_path: screenshotPaths[0] ?? null,
        extra_screenshot_paths: screenshotPaths.slice(1),
      })
      if (!result.ok) {
        toast.error(result.error ?? '创建发货批次失败')
        return
      }

      toast.success('发货批次已创建')
      setFormOpen(false)
      setQuantities({})
      setWholeOrderShipment(false)
      setIdempotencyKey('')
      clearScreenshotItems(screenshotItems)
      setScreenshotItems([])
      router.refresh()
    })
  }

  function handleVoid() {
    if (!voiding || !voidReason.trim()) return

    startTransition(async () => {
      const result = await voidBusinessOrderShipment(voiding.id, voidReason)
      if (!result.ok) {
        const message = result.error ?? '作废发货批次失败'
        toast.error(
          /return|退货|referenc/i.test(message)
            ? '该发货批次已被有效退货引用，不能作废；请先作废相关退货记录。'
            : message,
        )
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
          <p className="mt-1 text-sm text-muted-foreground">按产品记录分批发货；剩余数量按累计发货减有效退货后的净已发计算。</p>
        </div>
        {canManage && hasRemaining && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => openCreateForm(true)}>
              <Truck className="h-4 w-4" />整单发货
            </Button>
            <Button size="sm" onClick={() => openCreateForm()}>
              <PackagePlus className="h-4 w-4" />新增发货
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <h3 className="text-sm font-medium">产品发货进度</h3>
          <div className="grid gap-2">
            {itemRows.map(({ item, shipped, returned, netShipped, remaining }) => (
              <div
                key={item.id}
                className="grid gap-2 rounded-md border p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] sm:items-center sm:gap-5"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{businessOrderItemDisplayName(item)}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {businessOrderItemDisplaySku(item)} · {item.specification_snapshot || item.unit_snapshot}
                  </div>
                </div>
                <div className="flex justify-between gap-3 sm:block sm:text-right">
                  <span className="text-muted-foreground sm:block">累计发货</span>
                  <span className="font-medium tabular-nums">{formatQuantity(shipped)}</span>
                </div>
                <div className="flex justify-between gap-3 sm:block sm:text-right">
                  <span className="text-muted-foreground sm:block">累计退货</span>
                  <span className="font-medium tabular-nums">{formatQuantity(returned)}</span>
                </div>
                <div className="flex justify-between gap-3 sm:block sm:text-right">
                  <span className="text-muted-foreground sm:block">净已发</span>
                  <span className="font-medium tabular-nums">{formatQuantity(netShipped)}</span>
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
                      发货单号：{shipment.tracking_number || '—'}
                    </p>
                    {(shipment.screenshot_path ||
                      (shipment.extra_screenshot_paths?.length ?? 0) > 0) && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2"
                        disabled={pending}
                        onClick={() => viewShipmentScreenshot(shipment.id)}
                      >
                        <Eye className="h-3.5 w-3.5" />查看截图
                      </Button>
                    )}
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
                          {item
                            ? `${businessOrderItemDisplayName(item)}（${businessOrderItemDisplaySku(item)}）`
                            : '订单产品'}
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
            <DialogTitle>{wholeOrderShipment ? '整单发货' : '新增发货批次'}</DialogTitle>
            <DialogDescription>
              {wholeOrderShipment
                ? '已按每个产品的剩余数量预填，可在提交前调整；本次数量不能超过剩余数量。'
                : '只会提交数量大于 0 的产品，且本次数量不能超过剩余数量。'}
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleCreate}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="shipment_shipped_at">发货时间</Label>
                <Input
                  id="shipment_shipped_at"
                  type="datetime-local"
                  value={shippedAt}
                  max={getBusinessDateTimeLocal()}
                  onChange={(event) => setShippedAt(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="shipment_tracking_number">发货单号</Label>
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
                      <div className="truncate font-medium">{businessOrderItemDisplayName(item)}</div>
                      <div className="text-xs text-muted-foreground">
                        剩余 {formatQuantity(remaining)} {item.unit_snapshot}
                      </div>
                    </div>
                    <Input
                      aria-label={`${businessOrderItemDisplayName(item)}本次发货数量`}
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
              <Label htmlFor="shipment_screenshot">发货截图（可选，最多 10 张）</Label>
              <div
                ref={screenshotPasteRef}
                className={`rounded-md border border-dashed p-3 transition-colors ${screenshotDragging ? 'border-primary bg-primary/5' : 'border-input'}`}
                {...screenshotDropProps}
              >
                <Input
                  id="shipment_screenshot"
                  type="file"
                  accept=".jpg,.jpeg,.png,image/jpeg,image/png"
                  multiple
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? [])
                    event.target.value = ''
                    addScreenshotFiles(files)
                  }}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  支持拖放、粘贴或选择多张 JPG/PNG 截图，单张最大 20MB，可不传。
                </p>
              </div>
              {screenshotItems.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {screenshotItems.map((item, index) => (
                    <div
                      key={item.previewUrl}
                      className="relative h-16 w-16 overflow-hidden rounded border bg-muted"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={item.previewUrl}
                        alt={`发货截图 ${index + 1}`}
                        className="h-full w-full object-cover"
                      />
                      <button
                        type="button"
                        title="移除图片"
                        onClick={() => removeScreenshotItem(index)}
                        className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
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

      <Dialog
        open={Boolean(viewingScreenshotUrls)}
        onOpenChange={(open) => !open && setViewingScreenshotUrls(null)}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>发货截图（{viewingScreenshotUrls?.length ?? 0} 张）</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {viewingScreenshotUrls?.map((url, index) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={url}
                src={url}
                alt={`发货截图 ${index + 1}`}
                className="w-full rounded-md border"
              />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
