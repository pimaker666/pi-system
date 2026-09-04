'use client'

import { FormEvent, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { CustomerCombobox } from '@/components/customers/customer-combobox'
import { ProductCombobox } from '@/components/products/product-combobox'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { createBusinessOrder, updateBusinessOrder } from '@/lib/actions/business-orders'
import { formatCurrency } from '@/lib/utils'
import type {
  BusinessFulfillmentType,
  BusinessOrderWithDetails,
  CurrencyCode,
  Customer,
  CustomerGroup,
  Product,
  Profile,
} from '@/types'

interface EditableItem {
  key: string
  product_id: string
  product_name: string
  sku: string
  unit: string
  quantity: number
  unit_price: number
}

interface BusinessOrderFormProps {
  profile: Pick<Profile, 'role'>
  customers: Customer[]
  customerGroups: CustomerGroup[]
  products: Product[]
  initialOrder?: BusinessOrderWithDetails
}

const currencies: CurrencyCode[] = ['USD', 'EUR', 'CNY', 'GBP', 'JPY']

export function BusinessOrderForm({
  profile,
  customers,
  customerGroups,
  products,
  initialOrder,
}: BusinessOrderFormProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [customer, setCustomer] = useState<Customer | null>(
    customers.find((item) => item.id === initialOrder?.customer_id) ?? null,
  )
  const [orderDate, setOrderDate] = useState(
    initialOrder?.order_date ?? new Date().toISOString().slice(0, 10),
  )
  const [fulfillmentType, setFulfillmentType] = useState<BusinessFulfillmentType>(
    initialOrder?.fulfillment_type ?? 'custom',
  )
  const [currency, setCurrency] = useState<CurrencyCode>(initialOrder?.currency ?? 'USD')
  const [exchangeRate, setExchangeRate] = useState(
    String(initialOrder?.exchange_rate_to_cny ?? ''),
  )
  const [shippingFee, setShippingFee] = useState(String(initialOrder?.shipping_fee ?? 0))
  const [trackingNumber, setTrackingNumber] = useState(initialOrder?.tracking_number ?? '')
  const [salesNotes, setSalesNotes] = useState(initialOrder?.sales_notes ?? '')
  const [correctionReason, setCorrectionReason] = useState('')
  const [selectedProductId, setSelectedProductId] = useState('')
  const [items, setItems] = useState<EditableItem[]>(
    initialOrder?.business_order_items.map((item) => ({
      key: item.id,
      product_id: item.product_id ?? '',
      product_name: item.name_snapshot,
      sku: item.sku_snapshot,
      unit: item.unit_snapshot,
      quantity: Number(item.quantity),
      unit_price: Number(item.unit_price),
    })) ?? [],
  )

  const subtotal = useMemo(
    () => items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0),
    [items],
  )
  const total = subtotal + (Number(shippingFee) || 0)
  const correctionRequired = Boolean(initialOrder && profile.role !== 'sales')

  function addProduct() {
    const product = products.find((item) => item.id === selectedProductId)
    if (!product) return
    if (items.some((item) => item.product_id === product.id)) {
      toast.error('该产品已在订单中')
      return
    }
    setItems((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        product_id: product.id,
        product_name: product.name,
        sku: product.sku,
        unit: product.unit,
        quantity: 1,
        unit_price: Number(product.unit_price),
      },
    ])
    setSelectedProductId('')
  }

  function updateItem(key: string, field: 'quantity' | 'unit_price', value: string) {
    const number = Number(value)
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, [field]: number } : item)),
    )
  }

  function handleCurrencyChange(value: CurrencyCode) {
    setCurrency(value)
    if (value === 'CNY') setExchangeRate('1')
    else if (currency === 'CNY') setExchangeRate('')
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!customer) {
      toast.error('请选择客户')
      return
    }
    if (items.length === 0 || items.some((item) => !item.product_id)) {
      toast.error('请至少添加一个有效产品')
      return
    }

    const input = {
      customer_id: customer.id,
      order_date: orderDate,
      fulfillment_type: fulfillmentType,
      currency,
      exchange_rate_to_cny: exchangeRate,
      shipping_fee: shippingFee,
      tracking_number: trackingNumber,
      sales_notes: salesNotes,
      items: items.map((item) => ({
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: item.unit_price,
      })),
    }

    startTransition(async () => {
      const result = initialOrder
        ? await updateBusinessOrder(
            initialOrder.id,
            initialOrder.version,
            input,
            correctionReason,
          )
        : await createBusinessOrder(input)

      if (!result.ok) {
        toast.error(result.error ?? '保存业务订单失败')
        return
      }

      toast.success(initialOrder ? '业务订单已更新' : '业务订单草稿已创建')
      router.push(`/finance/performance/${result.id ?? initialOrder?.id}`)
      router.refresh()
    })
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">订单信息</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 sm:col-span-2">
            <Label>客户</Label>
            <CustomerCombobox
              customers={customers}
              groups={customerGroups}
              value={customer}
              onChange={setCustomer}
              allowCreate={profile.role === 'sales'}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="order_date">订单日期</Label>
            <Input
              id="order_date"
              type="date"
              value={orderDate}
              onChange={(event) => setOrderDate(event.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label>订单属性</Label>
            <Select
              value={fulfillmentType}
              onValueChange={(value) => setFulfillmentType(value as BusinessFulfillmentType)}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="custom">定制</SelectItem>
                <SelectItem value="stock">现货</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>币种</Label>
            <Select value={currency} onValueChange={(value) => handleCurrencyChange(value as CurrencyCode)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {currencies.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="exchange_rate">兑人民币汇率</Label>
            <Input
              id="exchange_rate"
              type="number"
              min="0.00000001"
              max="1000000"
              step="0.00000001"
              value={currency === 'CNY' ? '1' : exchangeRate}
              onChange={(event) => setExchangeRate(event.target.value)}
              readOnly={currency === 'CNY'}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="shipping_fee">运费</Label>
            <Input
              id="shipping_fee"
              type="number"
              min="0"
              step="0.01"
              value={shippingFee}
              onChange={(event) => setShippingFee(event.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tracking_number">货运单号</Label>
            <Input
              id="tracking_number"
              value={trackingNumber}
              onChange={(event) => setTrackingNumber(event.target.value)}
              maxLength={200}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="sales_notes">业务备注</Label>
            <Textarea
              id="sales_notes"
              value={salesNotes}
              onChange={(event) => setSalesNotes(event.target.value)}
              maxLength={2000}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">产品明细</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <ProductCombobox
              products={products}
              value={selectedProductId}
              onChange={setSelectedProductId}
              placeholder="从产品库选择产品"
              className="flex-1"
            />
            <Button type="button" variant="outline" onClick={addProduct} disabled={!selectedProductId}>
              <Plus className="h-4 w-4" />添加产品
            </Button>
          </div>

          <div className="space-y-3">
            {items.map((item) => (
              <div key={item.key} className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_140px_160px_120px_40px] sm:items-end">
                <div>
                  <div className="font-medium">{item.product_name}</div>
                  <div className="text-xs text-muted-foreground">{item.sku} · {item.unit}</div>
                </div>
                <div className="space-y-1">
                  <Label>数量</Label>
                  <Input
                    type="number"
                    min="0.0001"
                    step="0.0001"
                    value={item.quantity}
                    onChange={(event) => updateItem(item.key, 'quantity', event.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1">
                  <Label>成交单价（{currency}）</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={item.unit_price}
                    onChange={(event) => updateItem(item.key, 'unit_price', event.target.value)}
                    required
                  />
                </div>
                <div className="text-right font-medium tabular-nums">
                  {formatCurrency(item.quantity * item.unit_price, currency)}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))}
                  aria-label="移除产品"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {items.length === 0 && (
              <div className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
                尚未添加产品
              </div>
            )}
          </div>

          <div className="ml-auto max-w-sm space-y-2 border-t pt-4 text-sm">
            <div className="flex justify-between"><span>产品小计</span><span>{formatCurrency(subtotal, currency)}</span></div>
            <div className="flex justify-between"><span>运费</span><span>{formatCurrency(Number(shippingFee) || 0, currency)}</span></div>
            <div className="flex justify-between text-base font-semibold"><span>订单总额</span><span>{formatCurrency(total, currency)}</span></div>
          </div>
        </CardContent>
      </Card>

      {correctionRequired && (
        <Card>
          <CardHeader><CardTitle className="text-base">修正说明</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <Label htmlFor="correction_reason">已完成订单的修正原因</Label>
            <Textarea
              id="correction_reason"
              value={correctionReason}
              onChange={(event) => setCorrectionReason(event.target.value)}
              maxLength={1000}
              required
            />
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end gap-2">
        <Button asChild type="button" variant="outline">
          <Link href={initialOrder ? `/finance/performance/${initialOrder.id}` : '/finance/performance'}>取消</Link>
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? '保存中…' : initialOrder ? '保存修改' : '创建草稿'}
        </Button>
      </div>
    </form>
  )
}
