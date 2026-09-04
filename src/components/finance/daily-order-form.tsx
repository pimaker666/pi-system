'use client'

import { FormEvent, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Eye, Trash2 } from 'lucide-react'
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
  createDailyOrder,
  getDailyOrderScreenshotUrl,
  removeDailyOrderScreenshot,
  updateDailyOrder,
} from '@/lib/actions/daily-orders'
import type {
  CurrencyCode,
  DailyOrder,
  DailyOrderPaymentCategory,
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

type MoneyField = 'sales_unit_price' | 'product_received' | 'logistics_fee' | 'sales_total'

interface PendingScreenshot {
  id: string
  file: File
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
  const [pending, startTransition] = useTransition()
  const [orderDate, setOrderDate] = useState(initialOrder?.order_date ?? today)
  const [shippingDate, setShippingDate] = useState(initialOrder?.shipping_date ?? initialOrder?.order_date ?? today)
  const [shippingDateEdited, setShippingDateEdited] = useState(Boolean(initialOrder))
  const [shopId, setShopId] = useState(initialOrder?.shop_id ?? '')
  const [salespersonId, setSalespersonId] = useState(initialOrder?.salesperson_id ?? '')
  const [productId, setProductId] = useState(initialOrder?.product_id ?? '')
  const [files, setFiles] = useState<PendingScreenshot[]>([])
  const [screenshots, setScreenshots] = useState(
    initialOrder?.finance_daily_order_screenshots?.filter((item) => item.status === 'active') ?? [],
  )
  const [currencies, setCurrencies] = useState<Record<MoneyField, CurrencyCode>>({
    sales_unit_price: initialOrder?.sales_unit_price_currency ?? 'CNY',
    product_received: initialOrder?.product_received_currency ?? 'CNY',
    logistics_fee: initialOrder?.logistics_fee_currency ?? 'CNY',
    sales_total: initialOrder?.sales_total_currency ?? 'CNY',
  })
  const assignedSalespeople = useMemo(() => {
    const ids = new Set(shops.find((shop) => shop.id === shopId)?.salespersonIds ?? [])
    return salespeople.filter((person) => ids.has(person.id))
  }, [shopId, shops, salespeople])

  function changeShop(value: string) {
    setShopId(value)
    const ids = shops.find((shop) => shop.id === value)?.salespersonIds ?? []
    if (!ids.includes(salespersonId)) setSalespersonId('')
  }

  function selectFiles(next: FileList | null) {
    const selected = Array.from(next ?? [])
    if (screenshots.length + selected.length > 10) return toast.error('每条订单最多 10 张截图')
    const invalid = selected.find((file) => !['image/jpeg', 'image/png'].includes(file.type) || file.size > 5 * 1024 * 1024)
    if (invalid) return toast.error(`${invalid.name} 不是 JPEG/PNG 或超过 5MB`)
    setFiles(selected.map((file) => ({ id: crypto.randomUUID(), file })))
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
    const input = {
      order_date: orderDate,
      shop_id: shopId,
      salesperson_id: salespersonId,
      order_number: data.get('order_number'),
      shipping_date: shippingDate,
      shipping_number: data.get('shipping_number'),
      shipping_category: data.get('shipping_category'),
      product_id: productId,
      quantity: data.get('quantity'),
      sales_unit_price_amount: data.get('sales_unit_price_amount'),
      sales_unit_price_currency: currencies.sales_unit_price,
      product_received_amount: data.get('product_received_amount'),
      product_received_currency: currencies.product_received,
      logistics_fee_amount: data.get('logistics_fee_amount'),
      logistics_fee_currency: currencies.logistics_fee,
      sales_total_amount: data.get('sales_total_amount'),
      sales_total_currency: currencies.sales_total,
      payment_category: data.get('payment_category'),
      remarks: data.get('remarks'),
    }
    startTransition(async () => {
      const result = initialOrder
        ? await updateDailyOrder(initialOrder.id, initialOrder.version, input)
        : await createDailyOrder(input)
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
      toast.success(initialOrder ? '订单行已更新' : '订单行已创建')
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

  const moneyField = (field: MoneyField, label: string, defaultValue: number | undefined) => (
    <div className="space-y-2">
      <Label htmlFor={`${field}_amount`}>{label}</Label>
      <div className="flex gap-2">
        <Select value={currencies[field]} onValueChange={(value) => setCurrencies((current) => ({ ...current, [field]: value as CurrencyCode }))}>
          <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="CNY">CNY</SelectItem><SelectItem value="USD">USD</SelectItem></SelectContent>
        </Select>
        <Input id={`${field}_amount`} name={`${field}_amount`} type="number" min="0" max="999999999999" step="0.01" defaultValue={defaultValue ?? 0} required />
      </div>
    </div>
  )

  return (
    <form className="space-y-6" onSubmit={submit}>
      <Card>
        <CardHeader><CardTitle className="text-base">订单行信息</CardTitle></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div className="space-y-2"><Label>下单日期</Label><Input type="date" value={orderDate} onChange={(event) => { const value = event.target.value; setOrderDate(value); if (!shippingDateEdited) setShippingDate(value) }} required /></div>
          <div className="space-y-2"><Label>店铺</Label><Select value={shopId} onValueChange={changeShop}><SelectTrigger><SelectValue placeholder="选择店铺" /></SelectTrigger><SelectContent>{shops.filter((shop) => shop.is_active || shop.id === initialOrder?.shop_id).map((shop) => <SelectItem key={shop.id} value={shop.id}>{shop.name}{shop.is_active ? '' : '（停用）'}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-2"><Label>业务员</Label><Select value={salespersonId} onValueChange={setSalespersonId}><SelectTrigger><SelectValue placeholder="选择业务员" /></SelectTrigger><SelectContent>{assignedSalespeople.map((person) => <SelectItem key={person.id} value={person.id}>{person.full_name || person.email}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-2"><Label htmlFor="order_number">订单号</Label><Input id="order_number" name="order_number" defaultValue={initialOrder?.order_number} maxLength={200} required /></div>
          <div className="space-y-2"><Label>发货日期</Label><Input type="date" value={shippingDate} onChange={(event) => { setShippingDate(event.target.value); setShippingDateEdited(true) }} required /></div>
          <div className="space-y-2"><Label htmlFor="shipping_number">发货单号</Label><Input id="shipping_number" name="shipping_number" defaultValue={initialOrder?.shipping_number ?? ''} maxLength={200} /></div>
          <div className="space-y-2"><Label>发货分类</Label><Select name="shipping_category" defaultValue={initialOrder?.shipping_category ?? 'stock'}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="stock">现货</SelectItem><SelectItem value="sample">样品</SelectItem><SelectItem value="custom">定制</SelectItem></SelectContent></Select></div>
          <div className="space-y-2"><Label>产品</Label><ProductCombobox products={products} value={productId} onChange={setProductId} placeholder="选择产品" className="w-full" /></div>
          <div className="space-y-2"><Label htmlFor="quantity">数量</Label><Input id="quantity" name="quantity" type="number" min="0.0001" max="999999999999" step="0.0001" defaultValue={initialOrder?.quantity ?? 1} required /></div>
          {moneyField('sales_unit_price', '销售单价', initialOrder?.sales_unit_price_amount)}
          {moneyField('product_received', '产品实收金额', initialOrder?.product_received_amount)}
          {moneyField('logistics_fee', '物流费用', initialOrder?.logistics_fee_amount)}
          {moneyField('sales_total', '销售总金额', initialOrder?.sales_total_amount)}
          <div className="space-y-2"><Label>收款分类</Label><Select name="payment_category" defaultValue={initialOrder?.payment_category ?? 'full'}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="full">全款</SelectItem><SelectItem value="deposit">定金</SelectItem><SelectItem value="balance">尾款</SelectItem></SelectContent></Select></div>
          <div className="space-y-2 md:col-span-2 xl:col-span-3"><Label htmlFor="remarks">备注</Label><Textarea id="remarks" name="remarks" defaultValue={initialOrder?.remarks ?? ''} maxLength={2000} /></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">截图（JPEG/PNG，每张 ≤5MB，最多10张）</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {screenshots.map((shot) => <div key={shot.id} className="flex items-center justify-between rounded-md border p-2 text-sm"><span className="truncate">{shot.original_name || '截图'}</span><div className="flex"><Button type="button" variant="ghost" size="icon" onClick={() => viewScreenshot(shot.id)} aria-label="查看截图"><Eye className="h-4 w-4" /></Button><Button type="button" variant="ghost" size="icon" onClick={() => removeScreenshot(shot.id)} aria-label="移除截图"><Trash2 className="h-4 w-4 text-destructive" /></Button></div></div>)}
          <Input type="file" accept="image/jpeg,image/png" multiple onChange={(event) => selectFiles(event.target.files)} disabled={screenshots.length >= 10} />
          {files.length > 0 && <p className="text-xs text-muted-foreground">待上传：{files.map((item) => item.file.name).join('、')}</p>}
        </CardContent>
      </Card>
      <div className="flex justify-end gap-2"><Button asChild type="button" variant="outline"><Link href="/finance/daily-orders">取消</Link></Button><Button type="submit" disabled={pending}>{pending ? '保存中…' : initialOrder ? '保存修改' : '创建订单行'}</Button></div>
    </form>
  )
}
