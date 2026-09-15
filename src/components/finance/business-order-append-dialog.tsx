'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'
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
import { ProductCombobox, type ProductComboboxOption } from '@/components/products/product-combobox'
import {
  appendBusinessOrderItems,
  listBusinessOrderAppendCatalog,
} from '@/lib/actions/business-orders'
import { formatCurrency } from '@/lib/utils'
import type {
  BusinessCustomProductListItem,
  CurrencyCode,
  DailyOrderShippingCategory,
  Product,
  ProductGroup,
} from '@/types'
import { BusinessCustomProductPicker } from './business-custom-product-picker'

const SHIPPING_OPTIONS: Array<{ value: DailyOrderShippingCategory; label: string }> = [
  { value: 'stock', label: '现货' },
  { value: 'sample', label: '样品' },
  { value: 'custom', label: '定制' },
  { value: 'purchase', label: '外采' },
]

function roundMoney(value: number) {
  return Math.round(value * 100) / 100
}

function numericValue(value: unknown) {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

function derivedOrderAmount(quantity: string, unitPrice: string) {
  return roundMoney(numericValue(quantity) * numericValue(unitPrice))
}

function derivedOutstanding(quantity: string, unitPrice: string, received: string) {
  return String(roundMoney(derivedOrderAmount(quantity, unitPrice) - numericValue(received)))
}

// 生产通过 http 访问时属于非安全上下文，crypto.randomUUID 不可用。
function newRowKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `row-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

interface AppendRow {
  key: string
  sourceType: 'catalog' | 'custom'
  productId: string
  customProduct: BusinessCustomProductListItem | null
  quantity: string
  unitPrice: string
  dailyShippingCategory: DailyOrderShippingCategory
  receivedAmount: string
  outstandingAmount: string
}

function emptyRow(): AppendRow {
  return {
    key: newRowKey(),
    sourceType: 'catalog',
    productId: '',
    customProduct: null,
    quantity: '',
    unitPrice: '',
    dailyShippingCategory: 'stock',
    receivedAmount: '',
    outstandingAmount: '0',
  }
}

interface BusinessOrderAppendDialogProps {
  orderId: string
  orderVersion: number
  currency: CurrencyCode
  hasDailyFields: boolean
  needsReapproval?: boolean
}

export function BusinessOrderAppendDialog({
  orderId,
  orderVersion,
  currency,
  hasDailyFields,
  needsReapproval = false,
}: BusinessOrderAppendDialogProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [catalog, setCatalog] = useState<{
    products: Product[]
    productGroups: ProductGroup[]
  } | null>(null)
  const [rows, setRows] = useState<AppendRow[]>(() => [emptyRow()])
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (!open || catalog) return
    let active = true
    listBusinessOrderAppendCatalog()
      .then((result) => {
        if (!active) return
        if (result.ok && result.data) {
          setCatalog(result.data)
        } else {
          toast.error(result.error ?? '读取产品列表失败')
        }
      })
      .catch(() => {
        if (active) toast.error('读取产品列表失败，请稍后重试')
      })
    return () => {
      active = false
    }
  }, [open, catalog])

  const productOptions = useMemo<ProductComboboxOption[]>(
    () =>
      (catalog?.products ?? []).map((product) => ({
        id: product.id,
        name: product.name,
        sku: product.sku,
        image_url: product.image_url,
        unit_price: product.unit_price,
        currency: product.currency,
        unit: product.unit,
        group_id: product.group_id,
        financial_number: product.financial_number,
      })),
    [catalog],
  )

  const appendedSubtotal = useMemo(
    () =>
      rows.reduce((sum, row) => {
        const quantity = Number(row.quantity)
        const unitPrice = Number(row.unitPrice)
        if (!Number.isFinite(quantity) || quantity <= 0) return sum
        if (!Number.isFinite(unitPrice) || unitPrice < 0) return sum
        return sum + Math.round(quantity * unitPrice * 100) / 100
      }, 0),
    [rows],
  )

  function updateRow(key: string, patch: Partial<AppendRow>) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    )
  }

  function updateQuantity(key: string, value: string) {
    setRows((current) =>
      current.map((row) => {
        if (row.key !== key) return row
        return {
          ...row,
          quantity: value,
          outstandingAmount: derivedOutstanding(value, row.unitPrice, row.receivedAmount),
        }
      }),
    )
  }

  function updateUnitPrice(key: string, value: string) {
    setRows((current) =>
      current.map((row) => {
        if (row.key !== key) return row
        return {
          ...row,
          unitPrice: value,
          outstandingAmount: derivedOutstanding(row.quantity, value, row.receivedAmount),
        }
      }),
    )
  }

  function updateReceivedAmount(key: string, value: string) {
    setRows((current) =>
      current.map((row) => {
        if (row.key !== key) return row
        return {
          ...row,
          receivedAmount: value,
          outstandingAmount: derivedOutstanding(row.quantity, row.unitPrice, value),
        }
      }),
    )
  }

  function updateOutstandingAmount(key: string, value: string) {
    setRows((current) =>
      current.map((row) => {
        if (row.key !== key) return row
        const orderAmount = derivedOrderAmount(row.quantity, row.unitPrice)
        return {
          ...row,
          receivedAmount: String(Math.max(0, roundMoney(orderAmount - numericValue(value)))),
          outstandingAmount: value,
        }
      }),
    )
  }

  function handleCatalogSelect(row: AppendRow, productId: string) {
    const product = catalog?.products.find((item) => item.id === productId)
    const nextUnitPrice =
      product && product.currency === currency ? String(product.unit_price) : row.unitPrice
    updateRow(row.key, {
      productId,
      unitPrice: nextUnitPrice,
      outstandingAmount: derivedOutstanding(row.quantity, nextUnitPrice, row.receivedAmount),
    })
  }

  function handleCustomSelect(row: AppendRow, product: BusinessCustomProductListItem | null) {
    const quantity = product ? (product.quantity == null ? '' : String(product.quantity)) : ''
    const unitPrice =
      product && product.default_currency === currency
        ? String(product.default_unit_price)
        : ''
    const received =
      product && product.received_amount != null ? String(product.received_amount) : ''
    updateRow(row.key, {
      customProduct: product,
      quantity,
      unitPrice,
      receivedAmount: received,
      outstandingAmount: derivedOutstanding(quantity, unitPrice, received),
    })
  }

  function handleSubmit() {
    const items: Array<
      | {
          source_type: 'catalog'
          product_id: string
          quantity: number
          unit_price: number
        }
      | {
          source_type: 'custom'
          custom_product_id: string
          custom_product_version_id: string
          quantity: number
          unit_price: number
        }
    > = []
    for (const row of rows) {
      const quantity = Number(row.quantity)
      const unitPrice = Number(row.unitPrice)
      if (row.sourceType === 'catalog') {
        if (!row.productId) {
          toast.error('请选择要追加的产品')
          return
        }
        items.push({
          source_type: 'catalog' as const,
          product_id: row.productId,
          quantity,
          unit_price: unitPrice,
        })
      } else {
        if (!row.customProduct) {
          toast.error('请选择要追加的定制产品')
          return
        }
        items.push({
          source_type: 'custom' as const,
          custom_product_id: row.customProduct.custom_product_id,
          custom_product_version_id: row.customProduct.version_id,
          quantity,
          unit_price: unitPrice,
        })
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        toast.error('追加数量必须大于 0')
        return
      }
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        toast.error('成交单价不能为负')
        return
      }
      if (hasDailyFields) {
        const lineAmount = roundMoney(quantity * unitPrice)
        const productReceived =
          row.receivedAmount === '' ? 0 : roundMoney(Number(row.receivedAmount))
        if (!Number.isFinite(productReceived) || productReceived < 0) {
          toast.error('实收金额不能为负')
          return
        }
        const last = items[items.length - 1]
        Object.assign(last, {
          daily_shipping_category: row.dailyShippingCategory,
          product_received_amount: productReceived,
          product_received_overridden:
            Math.round(productReceived * 100) !== Math.round(lineAmount * 100),
          logistics_fee_amount: 0,
          sales_total_amount: roundMoney(productReceived + 0),
          sales_total_overridden: false,
        })
      }
    }

    startTransition(async () => {
      const result = await appendBusinessOrderItems({
        order_id: orderId,
        expected_version: orderVersion,
        reason,
        items,
      })
      if (!result.ok) {
        toast.error(result.error ?? '追加产品失败')
        return
      }
      toast.success(
        needsReapproval ? '加单成功，订单已重新提交审核' : '加单成功，订单金额已更新',
      )
      setOpen(false)
      setRows([emptyRow()])
      setReason('')
      router.refresh()
    })
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        追加产品
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) {
            setRows([emptyRow()])
            setReason('')
          }
        }}
      >
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>追加产品（加单）</DialogTitle>
            <DialogDescription>
              可直接追加产品明细，追加后订单应收金额会相应增加，并记录加单审计。
              {needsReapproval && ' 订单将重新进入待审核状态，由管理员确认后生效收款发货。'}
              {' '}同一产品多次追加会各自新增一行，不会覆盖历史下单数据。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {rows.map((row) => (
              <div
                key={row.key}
                className="grid grid-cols-1 items-end gap-3 rounded-md border p-3 xl:grid-cols-[130px_minmax(0,1.5fr)_110px_130px_130px_130px_130px_120px_40px]"
              >
                <div className="space-y-1">
                  <Label>类型</Label>
                  <Select
                    value={row.sourceType}
                    onValueChange={(value) =>
                      updateRow(row.key, {
                        sourceType: value as AppendRow['sourceType'],
                        productId: '',
                        customProduct: null,
                      })
                    }
                    disabled={pending}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="catalog">普通产品</SelectItem>
                      <SelectItem value="custom">定制产品</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>产品</Label>
                  {row.sourceType === 'catalog' ? (
                    <ProductCombobox
                      products={productOptions}
                      productGroups={catalog?.productGroups ?? []}
                      value={row.productId}
                      onChange={(productId) => handleCatalogSelect(row, productId)}
                      placeholder="选择产品"
                      disabled={pending || !catalog}
                    />
                  ) : (
                    <BusinessCustomProductPicker
                      orderCurrency={currency}
                      productGroups={catalog?.productGroups ?? []}
                      value={row.customProduct}
                      onChange={(product) => handleCustomSelect(row, product)}
                      onCreated={(product) => handleCustomSelect(row, product)}
                      disabled={pending}
                    />
                  )}
                </div>
                <div className="space-y-1">
                  <Label>数量</Label>
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    value={row.quantity}
                    onChange={(event) => updateQuantity(row.key, event.target.value)}
                    disabled={pending}
                  />
                </div>
                <div className="space-y-1">
                  <Label>成交单价（{currency}）</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={row.unitPrice}
                    onChange={(event) => updateUnitPrice(row.key, event.target.value)}
                    disabled={pending}
                  />
                </div>
                {hasDailyFields && (
                  <>
                    <div className="space-y-1">
                      <Label>订单金额（{currency}）</Label>
                      <Input
                        type="number"
                        value={(() => {
                          const amount = derivedOrderAmount(row.quantity, row.unitPrice)
                          return amount > 0 ? String(amount) : ''
                        })()}
                        readOnly
                        tabIndex={-1}
                        className="bg-muted/40"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>实收金额（{currency}）</Label>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={row.receivedAmount}
                        onChange={(event) => updateReceivedAmount(row.key, event.target.value)}
                        placeholder="可留空"
                        disabled={pending}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>未收尾款（{currency}）</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={row.outstandingAmount}
                        onChange={(event) => updateOutstandingAmount(row.key, event.target.value)}
                        disabled={pending}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>发货分类</Label>
                      <Select
                        value={row.dailyShippingCategory}
                        onValueChange={(value) =>
                          updateRow(row.key, {
                            dailyShippingCategory: value as DailyOrderShippingCategory,
                          })
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
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    setRows((current) =>
                      current.length > 1
                        ? current.filter((item) => item.key !== row.key)
                        : current,
                    )
                  }
                  disabled={pending || rows.length <= 1}
                  aria-label="删除该行"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRows((current) => [...current, emptyRow()])}
              disabled={pending}
            >
              <Plus className="h-4 w-4" />
              添加一行
            </Button>

            <div className="flex justify-end text-sm">
              <span className="text-muted-foreground">本次追加金额：</span>
              <span className="font-medium tabular-nums">
                {formatCurrency(appendedSubtotal, currency)}
              </span>
            </div>

            <div className="space-y-1">
              <Label htmlFor="append_reason">加单原因（选填）</Label>
              <Textarea
                id="append_reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
                disabled={pending}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={pending}>
              确认追加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
