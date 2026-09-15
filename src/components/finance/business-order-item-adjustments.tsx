'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  deleteBusinessOrderAppendedItem,
  editBusinessOrderAppendedItem,
} from '@/lib/actions/business-orders'
import type { BusinessOrderItem, CurrencyCode, DailyOrderShippingCategory } from '@/types'

const SHIPPING_OPTIONS: Array<{ value: DailyOrderShippingCategory; label: string }> = [
  { value: 'stock', label: '现货' },
  { value: 'sample', label: '样品' },
  { value: 'custom', label: '定制' },
  { value: 'purchase', label: '外采' },
]

function roundMoney(value: number) {
  return Math.round(value * 100) / 100
}

interface BusinessOrderItemAdjustmentsProps {
  orderId: string
  orderVersion: number
  currency: CurrencyCode
  hasDailyFields: boolean
  item: Pick<
    BusinessOrderItem,
    | 'id'
    | 'name_snapshot'
    | 'quantity'
    | 'unit_price'
    | 'daily_shipping_category'
    | 'product_received_amount'
    | 'logistics_fee_amount'
  >
}

export function BusinessOrderItemAdjustments({
  orderId,
  orderVersion,
  currency,
  hasDailyFields,
  item,
}: BusinessOrderItemAdjustmentsProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [quantity, setQuantity] = useState('')
  const [unitPrice, setUnitPrice] = useState('')
  const [receivedAmount, setReceivedAmount] = useState('')
  const [logisticsFee, setLogisticsFee] = useState('')
  const [dailyShippingCategory, setDailyShippingCategory] =
    useState<DailyOrderShippingCategory>('stock')
  const [reason, setReason] = useState('')

  function openEdit() {
    setQuantity(String(Number(item.quantity)))
    setUnitPrice(String(Number(item.unit_price)))
    setReceivedAmount(
      item.product_received_amount == null ? '' : String(Number(item.product_received_amount)),
    )
    setLogisticsFee(
      item.logistics_fee_amount == null ? '' : String(Number(item.logistics_fee_amount)),
    )
    setDailyShippingCategory(item.daily_shipping_category ?? 'stock')
    setReason('')
    setEditOpen(true)
  }

  function handleEditSubmit() {
    const nextQuantity = Number(quantity)
    const nextUnitPrice = Number(unitPrice)
    if (!Number.isFinite(nextQuantity) || nextQuantity <= 0) {
      toast.error('数量必须大于 0')
      return
    }
    if (!Number.isFinite(nextUnitPrice) || nextUnitPrice < 0) {
      toast.error('成交单价不能为负')
      return
    }
    const lineAmount = roundMoney(nextQuantity * nextUnitPrice)
    const productReceived =
      receivedAmount === '' ? lineAmount : roundMoney(Number(receivedAmount))
    if (!Number.isFinite(productReceived) || productReceived < 0) {
      toast.error('实收金额不能为负')
      return
    }
    const nextLogisticsFee = logisticsFee === '' ? 0 : roundMoney(Number(logisticsFee))
    if (!Number.isFinite(nextLogisticsFee) || nextLogisticsFee < 0) {
      toast.error('运费实收不能为负')
      return
    }
    startTransition(async () => {
      const result = await editBusinessOrderAppendedItem({
        order_id: orderId,
        expected_version: orderVersion,
        item_id: item.id,
        quantity: nextQuantity,
        unit_price: nextUnitPrice,
        ...(hasDailyFields
          ? {
              daily_shipping_category: dailyShippingCategory,
              product_received_amount: productReceived,
              product_received_overridden:
                Math.round(productReceived * 100) !== Math.round(lineAmount * 100),
              logistics_fee_amount: nextLogisticsFee,
              sales_total_amount: roundMoney(productReceived + nextLogisticsFee),
              sales_total_overridden: false,
            }
          : {}),
        reason,
      })
      if (!result.ok) {
        toast.error(result.error ?? '修改追加明细失败')
        return
      }
      toast.success('追加明细已修改')
      setEditOpen(false)
      router.refresh()
    })
  }

  function handleDeleteSubmit() {
    startTransition(async () => {
      const result = await deleteBusinessOrderAppendedItem({
        order_id: orderId,
        expected_version: orderVersion,
        item_id: item.id,
        reason,
      })
      if (!result.ok) {
        toast.error(result.error ?? '删除追加明细失败')
        return
      }
      toast.success('追加明细已删除')
      setDeleteOpen(false)
      setReason('')
      router.refresh()
    })
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={openEdit}
        disabled={pending}
        aria-label="修改追加明细"
      >
        <Pencil className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground hover:text-destructive"
        onClick={() => {
          setReason('')
          setDeleteOpen(true)
        }}
        disabled={pending}
        aria-label="删除追加明细"
      >
        <Trash2 className="h-4 w-4" />
      </Button>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>修改追加明细</DialogTitle>
            <DialogDescription>
              仅追加的产品明细支持修改，首次下单明细不可修改。数量不能低于净发货数量。
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>产品</Label>
              <Input value={item.name_snapshot} readOnly tabIndex={-1} className="bg-muted/40" />
            </div>
            <div className="space-y-1">
              <Label>订单金额（{currency}）</Label>
              <Input
                type="number"
                value={(() => {
                  const amount = roundMoney(Number(quantity || 0) * Number(unitPrice || 0))
                  return amount > 0 ? String(amount) : ''
                })()}
                readOnly
                tabIndex={-1}
                className="bg-muted/40"
              />
            </div>
            <div className="space-y-1">
              <Label>数量</Label>
              <Input
                type="number"
                min="0"
                step="any"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                disabled={pending}
              />
            </div>
            <div className="space-y-1">
              <Label>成交单价（{currency}）</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={unitPrice}
                onChange={(event) => setUnitPrice(event.target.value)}
                disabled={pending}
              />
            </div>
            {hasDailyFields && (
              <>
                <div className="space-y-1">
                  <Label>实收金额（{currency}）</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={receivedAmount}
                    onChange={(event) => setReceivedAmount(event.target.value)}
                    placeholder="默认=数量×单价"
                    disabled={pending}
                  />
                </div>
                <div className="space-y-1">
                  <Label>运费实收（{currency}）</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={logisticsFee}
                    onChange={(event) => setLogisticsFee(event.target.value)}
                    placeholder="默认 0"
                    disabled={pending}
                  />
                </div>
                <div className="space-y-1">
                  <Label>明细实收合计（{currency}）</Label>
                  <Input
                    type="number"
                    value={(() => {
                      const received =
                        receivedAmount === ''
                          ? roundMoney(Number(quantity || 0) * Number(unitPrice || 0))
                          : Number(receivedAmount)
                      const fee = logisticsFee === '' ? 0 : Number(logisticsFee)
                      return Number.isFinite(received) && Number.isFinite(fee)
                        ? String(roundMoney(received + fee))
                        : ''
                    })()}
                    readOnly
                    tabIndex={-1}
                    className="bg-muted/40"
                  />
                </div>
                <div className="space-y-1">
                  <Label>发货分类</Label>
                  <Select
                    value={dailyShippingCategory}
                    onValueChange={(value) =>
                      setDailyShippingCategory(value as DailyOrderShippingCategory)
                    }
                    disabled={pending}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SHIPPING_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="append_edit_reason">修改原因（选填）</Label>
              <Textarea
                id="append_edit_reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
                disabled={pending}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={pending}>
              取消
            </Button>
            <Button onClick={handleEditSubmit} disabled={pending}>
              确认修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除追加明细</DialogTitle>
            <DialogDescription>
              仅追加的产品明细支持删除，首次下单明细不可删除。删除后订单应收与实收金额会重新计算。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>产品</Label>
            <Input value={item.name_snapshot} readOnly tabIndex={-1} className="bg-muted/40" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="append_delete_reason">删除原因（选填）</Label>
            <Textarea
              id="append_delete_reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={1000}
              disabled={pending}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={pending}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleDeleteSubmit} disabled={pending}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
