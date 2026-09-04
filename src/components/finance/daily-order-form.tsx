'use client'

import { FormEvent, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Eye, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ProductCombobox } from '@/components/products/product-combobox'
import { createClient } from '@/lib/supabase/client'
import {
  bindDailyOrderScreenshot,
  bulkCreateDailyOrders,
  getDailyOrderScreenshotUrl,
  removeDailyOrderScreenshot,
  updateDailyOrder,
} from '@/lib/actions/daily-orders'
import type {
  CurrencyCode,
  DailyOrder,
  DailyOrderShippingCategory,
  DailyOrderShop,
  Product,
  Profile,
} from '@/types'

export interface DailyOrderShopOption extends DailyOrderShop {
  salespersonIds: string[]
}

interface Props {
  profileId: string
  shops: DailyOrderShopOption[]
  salespeople: Pick<Profile, 'id' | 'full_name' | 'email'>[]
  products: Pick<Product, 'id' | 'name' | 'sku' | 'image_url' | 'unit_price' | 'currency' | 'unit'>[]
  initialOrder?: DailyOrder
}

type MoneyKey = 'sales_unit_price' | 'product_received' | 'logistics_fee' | 'sales_total'
type TotalKey = 'product_received' | 'shipping_received' | 'sales'
type TotalAmountKey = 'product_received_amount' | 'logistics_fee_amount' | 'sales_total_amount'
type TotalCurrencyKey = 'product_received_currency' | 'logistics_fee_currency' | 'sales_total_currency'

const ORDER_TOTAL_FIELDS: Array<{
  key: TotalKey
  label: string
  amountKey: TotalAmountKey
  currencyKey: TotalCurrencyKey
}> = [
  { key: 'product_received', label: '总产品实收金额', amountKey: 'product_received_amount', currencyKey: 'product_received_currency' },
  { key: 'shipping_received', label: '总运费实收金额', amountKey: 'logistics_fee_amount', currencyKey: 'logistics_fee_currency' },
  { key: 'sales', label: '销售总金额', amountKey: 'sales_total_amount', currencyKey: 'sales_total_currency' },
]

interface LineItem {
  key: string
  shipping_category: DailyOrderShippingCategory
  product_id: string
  quantity: string
  sales_unit_price_amount: string
  sales_unit_price_currency: CurrencyCode
  product_received_amount: string
  product_received_currency: CurrencyCode
  logistics_fee_amount: string
  logistics_fee_currency: CurrencyCode
  sales_total_amount: string
  sales_total_currency: CurrencyCode
}

interface PendingScreenshot {
  id: string
  file: File
}

const SHIPPING_OPTIONS: Array<{ value: DailyOrderShippingCategory; label: string }> = [
  { value: 'stock', label: '现货' },
  { value: 'sample', label: '样品' },
  { value: 'custom', label: '定制' },
  { value: 'purchase', label: '外采' },
]

function newLocalId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function emptyLine(): LineItem {
  return {
    key: newLocalId('daily-order-line'),
    shipping_category: 'stock',
    product_id: '',
    quantity: '',
    sales_unit_price_amount: '',
    sales_unit_price_currency: 'CNY',
    product_received_amount: '',
    product_received_currency: 'CNY',
    logistics_fee_amount: '',
    logistics_fee_currency: 'CNY',
    sales_total_amount: '',
    sales_total_currency: 'CNY',
  }
}

function lineFromOrder(order: DailyOrder): LineItem {
  return {
    key: order.id,
    shipping_category: order.shipping_category,
    product_id: order.product_id ?? '',
    quantity: String(order.quantity ?? '1'),
    sales_unit_price_amount: String(order.sales_unit_price_amount ?? '0'),
    sales_unit_price_currency: order.sales_unit_price_currency ?? 'CNY',
    product_received_amount: String(order.product_received_amount ?? '0'),
    product_received_currency: order.product_received_currency ?? 'CNY',
    logistics_fee_amount: String(order.logistics_fee_amount ?? '0'),
    logistics_fee_currency: order.logistics_fee_currency ?? 'CNY',
    sales_total_amount: String(order.sales_total_amount ?? '0'),
    sales_total_currency: order.sales_total_currency ?? 'CNY',
  }
}

function normalizedAmount(value: string) {
  return value.trim() || '0'
}

function sumMoney(items: LineItem[], key: TotalAmountKey) {
  if (items.every((item) => item[key].trim() === '')) return ''
  const cents = items.reduce((sum, item) => {
    const amount = Number(normalizedAmount(item[key]))
    return sum + (Number.isFinite(amount) ? Math.round(amount * 100) : 0)
  }, 0)
  return (cents / 100).toFixed(2)
}

function currentBusinessDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

export function DailyOrderForm({ profileId, shops, salespeople, products, initialOrder }: Props) {
  const router = useRouter()
  const today = currentBusinessDate()
  const isEdit = Boolean(initialOrder)
  const [pending, startTransition] = useTransition()
  const [orderDate, setOrderDate] = useState(initialOrder?.order_date ?? today)
  const [shippingDate, setShippingDate] = useState(initialOrder?.shipping_date ?? initialOrder?.order_date ?? today)
  const [shippingDateEdited, setShippingDateEdited] = useState(isEdit)
  const [shopId, setShopId] = useState(initialOrder?.shop_id ?? '')
  const [salespersonId, setSalespersonId] = useState(initialOrder?.salesperson_id ?? '')
  const [items, setItems] = useState<LineItem[]>(() => (initialOrder ? [lineFromOrder(initialOrder)] : [emptyLine()]))
  const [totalOverrides, setTotalOverrides] = useState<Partial<Record<TotalKey, string>>>({})
  const automaticTotals = useMemo(() => Object.fromEntries(
    ORDER_TOTAL_FIELDS.map((field) => [field.key, sumMoney(items, field.amountKey)]),
  ) as Record<TotalKey, string>, [items])
  const mixedTotalCurrencies = useMemo(() => new Set(
    ORDER_TOTAL_FIELDS
      .filter((field) => items.some((item) => item[field.currencyKey] !== items[0]?.[field.currencyKey]))
      .map((field) => field.key),
  ), [items])
  const [files, setFiles] = useState<PendingScreenshot[]>([])
  const [screenshots, setScreenshots] = useState(
    initialOrder?.finance_daily_order_screenshots?.filter((item) => item.status === 'active') ?? [],
  )
  const assignedSalespeople = useMemo(() => {
    const ids = new Set(shops.find((shop) => shop.id === shopId)?.salespersonIds ?? [])
    return salespeople.filter((person) => ids.has(person.id))
  }, [shopId, shops, salespeople])

  function changeShop(value: string) {
    setShopId(value)
    const ids = shops.find((shop) => shop.id === value)?.salespersonIds ?? []
    if (!ids.includes(salespersonId)) setSalespersonId('')
  }

  function updateItem(index: number, patch: Partial<LineItem>) {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  function changeItemCurrency(index: number, key: MoneyKey, currency: CurrencyCode) {
    const currencyKey = `${key}_currency` as const
    updateItem(index, { [currencyKey]: currency })
    const totalKey = key === 'product_received'
      ? 'product_received'
      : key === 'logistics_fee'
        ? 'shipping_received'
        : key === 'sales_total'
          ? 'sales'
          : null
    if (totalKey) {
      setTotalOverrides((current) => {
        const next = { ...current }
        delete next[totalKey]
        return next
      })
    }
  }

  function addItem() {
    setItems((current) => {
      const next = emptyLine()
      const reference = current[0]
      if (reference) {
        next.sales_unit_price_currency = reference.sales_unit_price_currency
        next.product_received_currency = reference.product_received_currency
        next.logistics_fee_currency = reference.logistics_fee_currency
        next.sales_total_currency = reference.sales_total_currency
      }
      return [...current, next]
    })
  }

  function removeItem(index: number) {
    setItems((current) => (current.length <= 1 ? current : current.filter((_, i) => i !== index)))
  }

  function selectFiles(next: FileList | null) {
    const selected = Array.from(next ?? [])
    if (screenshots.length + selected.length > 10) return toast.error('每条订单最多 10 张截图')
    const invalid = selected.find((file) => !['image/jpeg', 'image/png'].includes(file.type) || file.size > 5 * 1024 * 1024)
    if (invalid) return toast.error(`${invalid.name} 不是 JPEG/PNG 或超过 5MB`)
    setFiles(selected.map((file) => ({ id: newLocalId('daily-order-screenshot'), file })))
  }

  async function uploadScreenshots(orderId: string) {
    const supabase = createClient()
    const failures: string[] = []
    for (const pendingFile of files) {
      const { file } = pendingFile
      try {
        const ext = file.type === 'image/png' ? 'png' : file.name.toLowerCase().endsWith('.jpeg') ? 'jpeg' : 'jpg'
        const objectPath = `${profileId}/${orderId}/${pendingFile.id}.${ext}`
        const bind = () => bindDailyOrderScreenshot({
          order_id: orderId,
          object_path: objectPath,
          original_name: file.name,
          mime_type: file.type,
          size_bytes: file.size,
        })
        const { error: uploadError } = await supabase.storage.from('finance-daily-order-screenshots').upload(objectPath, file, {
          contentType: file.type,
          upsert: false,
        })
        let bound
        try {
          bound = await bind()
        } catch (bindError) {
          if (!uploadError) await supabase.storage.from('finance-daily-order-screenshots').remove([objectPath])
          throw bindError
        }
        if (!bound.ok) {
          if (!uploadError) {
            const { error: cleanupError } = await supabase.storage.from('finance-daily-order-screenshots').remove([objectPath])
            if (cleanupError) throw new Error(`绑定失败且未能清理未绑定文件：${cleanupError.message}`)
          }
          throw new Error(uploadError ? `上传失败：${uploadError.message}` : bound.error || '绑定失败')
        }
        setFiles((current) => current.filter((item) => item.id !== pendingFile.id))
      } catch (error) {
        failures.push(`${file.name}：${error instanceof Error ? error.message : '上传失败'}`)
      }
    }
    return failures
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    if (!shopId) return toast.error('请选择店铺')
    if (!salespersonId) return toast.error('请选择业务员')
    if (items.some((item) => !item.product_id)) return toast.error('请为每个产品行选择产品')
    if (!isEdit && mixedTotalCurrencies.size > 0) {
      const labels = ORDER_TOTAL_FIELDS.filter((field) => mixedTotalCurrencies.has(field.key)).map((field) => field.label)
      return toast.error(`${labels.join('、')}对应的产品明细币种必须一致`)
    }
    const base = {
      order_date: orderDate,
      shop_id: shopId,
      salesperson_id: salespersonId,
      order_number: data.get('order_number'),
      shipping_date: shippingDate,
      shipping_number: data.get('shipping_number'),
      payment_category: data.get('payment_category'),
      remarks: data.get('remarks'),
    }
    const rows = items.map((item) => ({
      ...base,
      shipping_category: item.shipping_category,
      product_id: item.product_id,
      quantity: item.quantity,
      sales_unit_price_amount: normalizedAmount(item.sales_unit_price_amount),
      sales_unit_price_currency: item.sales_unit_price_currency,
      product_received_amount: normalizedAmount(item.product_received_amount),
      product_received_currency: item.product_received_currency,
      logistics_fee_amount: normalizedAmount(item.logistics_fee_amount),
      logistics_fee_currency: item.logistics_fee_currency,
      sales_total_amount: normalizedAmount(item.sales_total_amount),
      sales_total_currency: item.sales_total_currency,
    }))
    const firstItem = items[0]
    const totals = {
      total_product_received_amount: normalizedAmount(totalOverrides.product_received ?? automaticTotals.product_received),
      total_product_received_currency: firstItem.product_received_currency,
      total_product_received_overridden: totalOverrides.product_received !== undefined,
      total_shipping_received_amount: normalizedAmount(totalOverrides.shipping_received ?? automaticTotals.shipping_received),
      total_shipping_received_currency: firstItem.logistics_fee_currency,
      total_shipping_received_overridden: totalOverrides.shipping_received !== undefined,
      total_sales_amount: normalizedAmount(totalOverrides.sales ?? automaticTotals.sales),
      total_sales_currency: firstItem.sales_total_currency,
      total_sales_overridden: totalOverrides.sales !== undefined,
    }
    startTransition(async () => {
      if (initialOrder) {
        const result = await updateDailyOrder(initialOrder.id, initialOrder.version, rows[0])
        if (!result.ok || !result.id) {
          toast.error(result.error ?? '保存失败')
          return
        }
        const uploadFailures = await uploadScreenshots(result.id)
        if (uploadFailures.length > 0) {
          window.alert(`订单已保存，但以下截图上传失败，请在编辑页重新选择：\n${uploadFailures.join('\n')}`)
          window.location.assign(`/finance/daily-orders/${result.id}/edit`)
          return
        }
        toast.success('订单行已更新')
        router.push('/finance/daily-orders')
        router.refresh()
        return
      }
      const result = await bulkCreateDailyOrders(rows, totals)
      if (!result.ok || !result.ids?.length) {
        toast.error(result.error ?? '保存失败')
        return
      }
      const firstId = result.ids[0]
      const uploadFailures = files.length > 0 ? await uploadScreenshots(firstId) : []
      if (uploadFailures.length > 0) {
        window.alert(`订单已保存（共 ${result.ids.length} 个产品行），但以下截图上传失败，请在编辑页重新选择：\n${uploadFailures.join('\n')}`)
        window.location.assign(`/finance/daily-orders/${firstId}/edit`)
        return
      }
      toast.success(`已创建 ${result.ids.length} 个产品行`)
      router.push('/finance/daily-orders')
      router.refresh()
    })
  }

  function viewScreenshot(id: string) {
    startTransition(async () => {
      const result = await getDailyOrderScreenshotUrl(id)
      if (result.url) window.open(result.url, '_blank', 'noopener,noreferrer')
      else toast.error(result.error ?? '无法查看截图')
    })
  }

  function removeScreenshot(id: string) {
    if (!initialOrder || !window.confirm('确定移除这张截图吗？原文件将保留用于审计。')) return
    startTransition(async () => {
      const result = await removeDailyOrderScreenshot(id, initialOrder.id)
      if (!result.ok) {
        toast.error(result.error ?? '移除失败')
        return
      }
      setScreenshots((current) => current.filter((item) => item.id !== id))
      toast.success('截图已移除')
    })
  }

  const itemMoneyField = (item: LineItem, index: number, key: MoneyKey, label: string) => {
    const amountKey = `${key}_amount` as const
    const currencyKey = `${key}_currency` as const
    return (
      <div className="space-y-2">
        <Label>{label}</Label>
        <div className="flex gap-2">
          <Select
            value={item[currencyKey]}
            onValueChange={(value) => changeItemCurrency(index, key, value as CurrencyCode)}
          >
            <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="CNY">CNY</SelectItem><SelectItem value="USD">USD</SelectItem></SelectContent>
          </Select>
          <Input
            type="number"
            min="0"
            max="999999999999"
            step="0.01"
            value={item[amountKey]}
            onChange={(event) => updateItem(index, { [amountKey]: event.target.value })}
          />
        </div>
      </div>
    )
  }

  const orderTotalField = (field: (typeof ORDER_TOTAL_FIELDS)[number]) => {
    const overridden = totalOverrides[field.key] !== undefined
    const amount = totalOverrides[field.key] ?? automaticTotals[field.key]
    const currency = items[0]?.[field.currencyKey] ?? 'CNY'
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`order-total-${field.key}`}>{field.label}</Label>
          {overridden && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto px-2 py-1 text-xs"
              onClick={() => setTotalOverrides((current) => {
                const next = { ...current }
                delete next[field.key]
                return next
              })}
            >
              恢复自动计算
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <div className="flex h-10 w-24 items-center rounded-md border bg-muted px-3 text-sm">{currency}</div>
          <Input
            id={`order-total-${field.key}`}
            type="number"
            min="0"
            max="999999999999"
            step="0.01"
            value={amount}
            onChange={(event) => setTotalOverrides((current) => ({ ...current, [field.key]: event.target.value }))}
          />
        </div>
        {mixedTotalCurrencies.has(field.key) && (
          <p className="text-xs text-destructive">对应产品明细币种不一致，请统一币种后保存。</p>
        )}
      </div>
    )
  }

  return (
    <form className="space-y-6" onSubmit={submit}>
      <Card>
        <CardHeader><CardTitle className="text-base">订单信息</CardTitle></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div className="space-y-2"><Label>下单日期</Label><Input type="date" value={orderDate} onChange={(event) => { const value = event.target.value; setOrderDate(value); if (!shippingDateEdited) setShippingDate(value) }} required /></div>
          <div className="space-y-2"><Label>店铺</Label><Select value={shopId} onValueChange={changeShop}><SelectTrigger><SelectValue placeholder="选择店铺" /></SelectTrigger><SelectContent>{shops.filter((shop) => shop.is_active || shop.id === initialOrder?.shop_id).map((shop) => <SelectItem key={shop.id} value={shop.id}>{shop.name}{shop.is_active ? '' : '（停用）'}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-2"><Label>业务员</Label><Select value={salespersonId} onValueChange={setSalespersonId}><SelectTrigger><SelectValue placeholder="选择业务员" /></SelectTrigger><SelectContent>{assignedSalespeople.map((person) => <SelectItem key={person.id} value={person.id}>{person.full_name || person.email}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-2"><Label htmlFor="order_number">订单号</Label><Input id="order_number" name="order_number" defaultValue={initialOrder?.order_number} maxLength={200} required /></div>
          <div className="space-y-2"><Label>发货日期</Label><Input type="date" value={shippingDate} onChange={(event) => { setShippingDate(event.target.value); setShippingDateEdited(true) }} required /></div>
          <div className="space-y-2"><Label htmlFor="shipping_number">发货单号</Label><Input id="shipping_number" name="shipping_number" defaultValue={initialOrder?.shipping_number ?? ''} maxLength={200} /></div>
          <div className="space-y-2"><Label>收款分类</Label><Select name="payment_category" defaultValue={initialOrder?.payment_category ?? 'full'}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="full">全款</SelectItem><SelectItem value="deposit">定金</SelectItem><SelectItem value="balance">尾款</SelectItem></SelectContent></Select></div>
          <div className="space-y-2 md:col-span-2 xl:col-span-3"><Label htmlFor="remarks">备注</Label><Textarea id="remarks" name="remarks" defaultValue={initialOrder?.remarks ?? ''} maxLength={2000} /></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">产品明细{isEdit ? '' : `（共 ${items.length} 个）`}</CardTitle>
          {!isEdit && <Button type="button" variant="outline" size="sm" onClick={addItem}><Plus className="h-4 w-4" />添加产品</Button>}
        </CardHeader>
        <CardContent className="space-y-4">
          {items.map((item, index) => (
            <div key={item.key} className="rounded-md border p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">产品 {index + 1}</span>
                {!isEdit && items.length > 1 && <Button type="button" variant="ghost" size="icon" onClick={() => removeItem(index)} aria-label="移除产品"><Trash2 className="h-4 w-4 text-destructive" /></Button>}
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <div className="space-y-2"><Label>发货分类</Label><Select value={item.shipping_category} onValueChange={(value) => updateItem(index, { shipping_category: value as DailyOrderShippingCategory })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{SHIPPING_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div>
                <div className="space-y-2"><Label>产品</Label><ProductCombobox products={products} value={item.product_id} onChange={(value) => updateItem(index, { product_id: value })} placeholder="选择产品" className="w-full" /></div>
                <div className="space-y-2"><Label>数量</Label><Input type="number" min="0.0001" max="999999999999" step="0.0001" value={item.quantity} onChange={(event) => updateItem(index, { quantity: event.target.value })} required /></div>
                {itemMoneyField(item, index, 'sales_unit_price', '销售单价')}
                {itemMoneyField(item, index, 'product_received', '产品实收金额')}
                {itemMoneyField(item, index, 'logistics_fee', '运费实收金额')}
                {itemMoneyField(item, index, 'sales_total', '销售总金额')}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      {!isEdit && (
        <Card>
          <CardHeader><CardTitle className="text-base">订单总额</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {ORDER_TOTAL_FIELDS.map((field) => <div key={field.key}>{orderTotalField(field)}</div>)}
            </div>
            <p className="text-xs text-muted-foreground">默认自动加总各产品对应金额；产品金额留空按 0 计算。修改总额后会保留人工填写值，可点击“恢复自动计算”。</p>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader><CardTitle className="text-base">截图（JPEG/PNG，每张 ≤5MB，最多10张）</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {screenshots.map((shot) => <div key={shot.id} className="flex items-center justify-between rounded-md border p-2 text-sm"><span className="truncate">{shot.original_name || '截图'}</span><div className="flex"><Button type="button" variant="ghost" size="icon" onClick={() => viewScreenshot(shot.id)} aria-label="查看截图"><Eye className="h-4 w-4" /></Button><Button type="button" variant="ghost" size="icon" onClick={() => removeScreenshot(shot.id)} aria-label="移除截图"><Trash2 className="h-4 w-4 text-destructive" /></Button></div></div>)}
          <Input type="file" accept="image/jpeg,image/png" multiple onChange={(event) => selectFiles(event.target.files)} disabled={screenshots.length >= 10} />
          {files.length > 0 && <p className="text-xs text-muted-foreground">待上传：{files.map((item) => item.file.name).join('、')}</p>}
          {!isEdit && <p className="text-xs text-muted-foreground">截图会绑定到本次创建的第一个产品行。</p>}
        </CardContent>
      </Card>
      <div className="flex justify-end gap-2"><Button asChild type="button" variant="outline"><Link href="/finance/daily-orders">取消</Link></Button><Button type="submit" disabled={pending}>{pending ? '保存中…' : initialOrder ? '保存修改' : '创建订单'}</Button></div>
    </form>
  )
}
