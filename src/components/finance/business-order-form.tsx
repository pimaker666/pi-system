'use client'

import { FormEvent, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, LockKeyhole, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { CustomerCombobox } from '@/components/customers/customer-combobox'
import { BusinessCustomProductPicker } from '@/components/finance/business-custom-product-picker'
import { ProductCombobox } from '@/components/products/product-combobox'
import { Badge } from '@/components/ui/badge'
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
import { getBusinessDateKey } from '@/lib/business-orders'
import { formatCurrency } from '@/lib/utils'
import type {
  BusinessCustomProductListItem,
  BusinessFulfillmentType,
  BusinessOrderItemSourceType,
  BusinessOrderWithDetails,
  CurrencyCode,
  Customer,
  CustomerGroup,
  Product,
  Profile,
} from '@/types'

interface EditableItem {
  key: string
  source_type: BusinessOrderItemSourceType
  product_id: string | null
  custom_product_id: string | null
  custom_product_version_id: string | null
  product_name: string
  sku: string
  description: string | null
  specification: string | null
  unit: string
  quantity: number
  unit_price: number
  default_currency: CurrencyCode | null
  custom_scope: 'exclusive' | 'shared' | null
}

interface BusinessOrderFormProps {
  profile: Pick<Profile, 'role'>
  customers: Customer[]
  customerGroups: CustomerGroup[]
  products: Product[]
  initialOrder?: BusinessOrderWithDetails
}

const currencies: CurrencyCode[] = ['USD', 'EUR', 'CNY', 'GBP', 'JPY']

function newLocalId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `business-order-item-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

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
    initialOrder?.order_date ?? getBusinessDateKey(),
  )
  const [paymentDueDate, setPaymentDueDate] = useState(initialOrder?.payment_due_date ?? '')
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
  const [selectedCustomProduct, setSelectedCustomProduct] =
    useState<BusinessCustomProductListItem | null>(null)
  const [items, setItems] = useState<EditableItem[]>(
    initialOrder?.business_order_items
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((item) => ({
        key: item.id,
        source_type: item.source_type ?? (item.product_id ? 'catalog' : 'legacy'),
        product_id: item.product_id,
        custom_product_id: item.custom_product_id,
        custom_product_version_id: item.custom_product_version_id,
        product_name: item.name_snapshot,
        sku: item.sku_snapshot,
        description: item.description_snapshot,
        specification: item.specification_snapshot,
        unit: item.unit_snapshot,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        default_currency: null,
        custom_scope: null,
      })) ?? [],
  )

  const subtotal = useMemo(
    () => items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0),
    [items],
  )
  const total = subtotal + (Number(shippingFee) || 0)
  const correctionRequired = Boolean(initialOrder && ['admin', 'finance'].includes(profile.role))
  const hasLegacyItems = items.some((item) => item.source_type === 'legacy')
  const productRowsLocked = Boolean(
    initialOrder?.status === 'completed' && initialOrder.completion_gate_version === 2,
  )
  const productControlsDisabled = pending || productRowsLocked || hasLegacyItems

  function handleCustomerChange(nextCustomer: Customer) {
    if (nextCustomer.id !== customer?.id) {
      setSelectedCustomProduct(null)
      if (!productRowsLocked) {
        const customItemCount = items.filter((item) => item.source_type === 'custom').length
        if (customItemCount > 0) {
          setItems((current) => current.filter((item) => item.source_type !== 'custom'))
          toast.info('客户已变更，原客户的定制产品明细已移除')
        }
      }
    }
    setCustomer(nextCustomer)
  }

  function addProduct() {
    const product = products.find((item) => item.id === selectedProductId)
    if (!product) return
    if (items.some((item) => item.source_type === 'catalog' && item.product_id === product.id)) {
      toast.error('该产品已在订单中')
      return
    }
    const currencyMatches = product.currency === currency
    setItems((current) => [
      ...current,
      {
        key: newLocalId(),
        source_type: 'catalog',
        product_id: product.id,
        custom_product_id: null,
        custom_product_version_id: null,
        product_name: product.name,
        sku: product.sku,
        description: product.description,
        specification: product.specification,
        unit: product.unit,
        quantity: 1,
        unit_price: currencyMatches ? Number(product.unit_price) : 0,
        default_currency: product.currency,
        custom_scope: null,
      },
    ])
    if (!currencyMatches) toast.info('产品默认价币种与订单不同，成交单价已清零，请手工填写')
    setSelectedProductId('')
  }

  function addCustomProduct(product: BusinessCustomProductListItem, keepSelected = false) {
    if (items.some((item) => item.custom_product_version_id === product.version_id)) {
      toast.error('该定制产品版本已在订单中')
      return
    }
    const currencyMatches = product.default_currency === currency
    setItems((current) => [
      ...current,
      {
        key: newLocalId(),
        source_type: 'custom',
        product_id: null,
        custom_product_id: product.custom_product_id,
        custom_product_version_id: product.version_id,
        product_name: product.name,
        sku: product.code,
        description: product.description,
        specification: product.specification,
        unit: product.unit,
        quantity: 1,
        unit_price: currencyMatches ? Number(product.default_unit_price) : 0,
        default_currency: product.default_currency,
        custom_scope: product.is_shared ? 'shared' : 'exclusive',
      },
    ])
    if (!currencyMatches) toast.info('定制产品默认价币种与订单不同，成交单价已清零，请手工填写')
    if (!keepSelected) setSelectedCustomProduct(null)
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

    const mismatchedItems = items.filter(
      (item) => item.default_currency && item.default_currency !== value && item.unit_price !== 0,
    )
    if (mismatchedItems.length > 0) {
      setItems((current) =>
        current.map((item) =>
          item.default_currency && item.default_currency !== value
            ? { ...item, unit_price: 0 }
            : item,
        ),
      )
      toast.info('币种已变更，来源币种不同的新增产品单价已清零，请重新填写')
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (event.target !== event.currentTarget) return
    event.preventDefault()
    if (hasLegacyItems) {
      toast.error('订单含历史明细，V2 暂不支持写回，请联系管理员迁移或替换后再编辑')
      return
    }
    if (!customer) {
      toast.error('请选择客户')
      return
    }
    const hasInvalidItem = items.some((item) =>
      item.source_type === 'catalog'
        ? !item.product_id
        : !item.custom_product_id || !item.custom_product_version_id,
    )
    if (items.length === 0 || hasInvalidItem) {
      toast.error('请至少添加一个有效产品')
      return
    }

    const input = {
      customer_id: customer.id,
      order_date: orderDate,
      payment_due_date: paymentDueDate,
      fulfillment_type: fulfillmentType,
      currency,
      exchange_rate_to_cny: exchangeRate,
      shipping_fee: shippingFee,
      tracking_number: trackingNumber,
      sales_notes: salesNotes,
      items: items.map((item) => {
        if (item.source_type === 'catalog' && item.product_id) {
          return {
            source_type: 'catalog' as const,
            product_id: item.product_id,
            quantity: item.quantity,
            unit_price: item.unit_price,
          }
        }
        if (
          item.source_type === 'custom' &&
          item.custom_product_id &&
          item.custom_product_version_id
        ) {
          return {
            source_type: 'custom' as const,
            custom_product_id: item.custom_product_id,
            custom_product_version_id: item.custom_product_version_id,
            quantity: item.quantity,
            unit_price: item.unit_price,
          }
        }
        throw new Error('订单中存在无法写入的历史明细')
      }),
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
      {hasLegacyItems && (
        <div className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">该订单包含历史 legacy 产品明细，当前不可编辑</div>
            <div className="mt-1 text-muted-foreground">
              历史行会原样只读保留；V2 接口不接受 legacy 写入，请联系管理员迁移或替换后再修改订单。
            </div>
          </div>
        </div>
      )}

      <fieldset disabled={hasLegacyItems} className="space-y-6 disabled:opacity-70">
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
                onChange={handleCustomerChange}
                allowCreate={!hasLegacyItems && (profile.role === 'sales' || profile.role === 'supervisor')}
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
              <Label htmlFor="payment_due_date">尾款到期日</Label>
              <Input
                id="payment_due_date"
                type="date"
                value={paymentDueDate}
                onChange={(event) => setPaymentDueDate(event.target.value)}
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
            <div className="space-y-2 sm:col-span-2">
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
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              产品明细
              {productRowsLocked && (
                <Badge variant="outline" className="gap-1 font-normal">
                  <LockKeyhole className="h-3 w-3" />已完成订单，产品行已锁定
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label>普通产品库</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <ProductCombobox
                  products={products}
                  value={selectedProductId}
                  onChange={setSelectedProductId}
                  placeholder="从产品库选择产品"
                  disabled={productControlsDisabled}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={addProduct}
                  disabled={productControlsDisabled || !selectedProductId}
                >
                  <Plus className="h-4 w-4" />添加普通产品
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label>客户定制产品</Label>
              <div className="flex flex-col gap-2 lg:flex-row">
                <BusinessCustomProductPicker
                  customerId={customer?.id ?? null}
                  orderCurrency={currency}
                  profileRole={profile.role}
                  value={selectedCustomProduct}
                  onChange={setSelectedCustomProduct}
                  onCreated={(product) => addCustomProduct(product, true)}
                  allowCreate={['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)}
                  disabled={productControlsDisabled}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => selectedCustomProduct && addCustomProduct(selectedCustomProduct)}
                  disabled={productControlsDisabled || !selectedCustomProduct}
                >
                  <Plus className="h-4 w-4" />添加定制产品
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                选择客户后加载该客户专属及共享的未归档版本；新建产品会立即加入当前订单。
              </p>
            </div>

            <div className="space-y-3">
              {items.map((item) => {
                const rowLocked = productControlsDisabled || item.source_type === 'legacy'
                return (
                  <div
                    key={item.key}
                    className="grid gap-3 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_140px_160px_120px_40px] sm:items-end"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{item.product_name}</span>
                        <Badge variant={item.source_type === 'legacy' ? 'destructive' : item.source_type === 'custom' ? 'secondary' : 'outline'}>
                          {item.source_type === 'legacy'
                            ? '历史明细'
                            : item.source_type === 'custom'
                              ? item.custom_scope === 'shared'
                                ? '定制 · 共享'
                                : item.custom_scope === 'exclusive'
                                  ? '定制 · 客户专属'
                                  : '定制产品'
                              : '普通产品'}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">{item.sku} · {item.unit}</div>
                      {item.specification && (
                        <div className="mt-1 text-xs text-muted-foreground">规格：{item.specification}</div>
                      )}
                      {item.default_currency && item.default_currency !== currency && (
                        <div className="mt-1 text-xs text-amber-700">
                          默认价币种为 {item.default_currency}，成交单价未自动换算，请按 {currency} 手工填写。
                        </div>
                      )}
                      {item.source_type === 'legacy' && (
                        <div className="mt-1 text-xs text-destructive">此行仅保留展示，不可修改或删除。</div>
                      )}
                    </div>
                    <div className="space-y-1">
                      <Label>数量</Label>
                      <Input
                        type="number"
                        min="0.0001"
                        step="0.0001"
                        value={item.quantity}
                        onChange={(event) => updateItem(item.key, 'quantity', event.target.value)}
                        disabled={rowLocked}
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
                        disabled={rowLocked}
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
                      disabled={rowLocked}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )
              })}
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
      </fieldset>

      <div className="flex justify-end gap-2">
        <Button asChild type="button" variant="outline">
          <Link href={initialOrder ? `/finance/performance/${initialOrder.id}` : '/finance/performance'}>取消</Link>
        </Button>
        <Button type="submit" disabled={pending || hasLegacyItems}>
          {pending ? '保存中…' : initialOrder ? '保存修改' : '创建草稿'}
        </Button>
      </div>
    </form>
  )
}
