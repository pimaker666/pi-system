'use client'

import Image from 'next/image'
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useRef,
  useState,
  useTransition,
} from 'react'
import { ImageIcon, Loader2, Plus, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
  addBusinessCustomProductVersion,
  createBusinessCustomProduct,
} from '@/lib/actions/business-orders'
import { useImageUpload } from '@/lib/hooks/use-image-upload'
import { createClient } from '@/lib/supabase/client'
import { toImageSrc } from '@/lib/supabase/image'
import { roundToScale } from '@/lib/utils'
import type {
  BusinessCustomProductListItem,
  CurrencyCode,
  ProductGroup,
} from '@/types'

interface BusinessCustomProductDialogProps {
  defaultCurrency: CurrencyCode
  productGroups: ProductGroup[]
  disabled?: boolean
  mode?: 'create' | 'version'
  product?: BusinessCustomProductListItem
  context?: 'order' | 'library'
  onCreated: (product: BusinessCustomProductListItem) => void
}

const currencies: CurrencyCode[] = ['USD', 'EUR', 'CNY', 'GBP', 'JPY']
const MAX_IMAGE_SIZE = 20 * 1024 * 1024
const PRODUCT_IMAGE_PREFIX = '/storage/v1/object/public/product-images/'

function productImageObjectPath(url: string) {
  const markerIndex = url.indexOf(PRODUCT_IMAGE_PREFIX)
  if (markerIndex < 0) return null
  const encodedPath = url
    .slice(markerIndex + PRODUCT_IMAGE_PREFIX.length)
    .split(/[?#]/, 1)[0]
  try {
    return encodedPath
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
  } catch {
    return encodedPath
  }
}

function numericValue(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function roundMoney(value: number) {
  return roundToScale(value, 2)
}

function derivedOrderAmount(quantity: string, unitPrice: string) {
  return roundMoney(numericValue(quantity) * numericValue(unitPrice))
}

function derivedOutstanding(quantity: string, unitPrice: string, received: string) {
  return String(roundMoney(derivedOrderAmount(quantity, unitPrice) - numericValue(received)))
}

export function BusinessCustomProductDialog({
  defaultCurrency,
  productGroups,
  disabled = false,
  mode = 'create',
  product,
  context = 'order',
  onCreated,
}: BusinessCustomProductDialogProps) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [productGroupId, setProductGroupId] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [specification, setSpecification] = useState('')
  const [unit, setUnit] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [quantity, setQuantity] = useState('')
  const [defaultUnitPrice, setDefaultUnitPrice] = useState('')
  const [receivedAmount, setReceivedAmount] = useState('')
  const [outstandingAmount, setOutstandingAmount] = useState('')
  const [currency, setCurrency] = useState<CurrencyCode>(defaultCurrency)
  const [draggingImage, setDraggingImage] = useState(false)
  const uploadedPathsRef = useRef(new Set<string>())
  const { upload, uploading } = useImageUpload({
    bucket: 'product-images',
    folder: 'business-custom-products',
  })
  const isVersionMode = mode === 'version'

  function resetForm() {
    setProductGroupId(isVersionMode ? (product?.product_group_id ?? '') : '')
    setCode(isVersionMode ? (product?.code ?? '') : '')
    setName(isVersionMode ? (product?.name ?? '') : '')
    setDescription(isVersionMode ? (product?.description ?? '') : '')
    setSpecification(isVersionMode ? (product?.specification ?? '') : '')
    setUnit(isVersionMode ? (product?.unit ?? '') : '')
    setImageUrl(isVersionMode ? (product?.image_url ?? '') : '')
    const nextQuantity =
      isVersionMode && product?.quantity != null ? String(product.quantity) : ''
    const nextUnitPrice = isVersionMode && product ? String(product.default_unit_price) : ''
    const nextReceived =
      isVersionMode && product?.received_amount != null ? String(product.received_amount) : ''
    setQuantity(nextQuantity)
    setDefaultUnitPrice(nextUnitPrice)
    setReceivedAmount(nextReceived)
    setOutstandingAmount(derivedOutstanding(nextQuantity, nextUnitPrice, nextReceived))
    setCurrency(
      isVersionMode ? (product?.default_currency ?? defaultCurrency) : defaultCurrency,
    )
    setDraggingImage(false)
  }

  const orderAmount = derivedOrderAmount(quantity, defaultUnitPrice)

  function changeQuantity(value: string) {
    setQuantity(value)
    setOutstandingAmount(derivedOutstanding(value, defaultUnitPrice, receivedAmount))
  }

  function changeUnitPrice(value: string) {
    setDefaultUnitPrice(value)
    setOutstandingAmount(derivedOutstanding(quantity, value, receivedAmount))
  }

  function changeReceivedAmount(value: string) {
    setReceivedAmount(value)
    setOutstandingAmount(derivedOutstanding(quantity, defaultUnitPrice, value))
  }

  function changeOutstandingAmount(value: string) {
    setOutstandingAmount(value)
    setReceivedAmount(String(Math.max(0, roundMoney(orderAmount - numericValue(value)))))
  }

  async function cleanupUploadedImages(keepUrl?: string) {
    const keepPath = keepUrl ? productImageObjectPath(keepUrl) : null
    const paths = [...uploadedPathsRef.current].filter((path) => path !== keepPath)
    try {
      if (paths.length > 0) {
        const supabase = createClient()
        await supabase.storage.from('product-images').remove(paths)
      }
    } finally {
      uploadedPathsRef.current.clear()
    }
  }

  async function cleanupFailedUpload() {
    const currentUploadedPath = productImageObjectPath(imageUrl)
    const shouldClearImage =
      currentUploadedPath !== null && uploadedPathsRef.current.has(currentUploadedPath)
    try {
      await cleanupUploadedImages()
    } catch {
      // noop
    }
    if (shouldClearImage) setImageUrl('')
  }

  function handleOpenChange(nextOpen: boolean) {
    if (pending || uploading) return
    setOpen(nextOpen)
    if (nextOpen) {
      resetForm()
      return
    }
    void cleanupUploadedImages()
  }

  async function uploadImage(file: File) {
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      toast.error('仅支持 JPEG 或 PNG 图片')
      return
    }
    if (file.size > MAX_IMAGE_SIZE) {
      toast.error('产品图片不能超过 20MB')
      return
    }

    try {
      const url = await upload(file)
      const path = productImageObjectPath(url)
      if (path) uploadedPathsRef.current.add(path)
      setImageUrl(url)
      toast.success('图片已上传')
    } catch {
      toast.error('图片上传失败，请稍后重试')
    }
  }

  function handleImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void uploadImage(file)
  }

  function handleImageDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDraggingImage(false)
    const file = event.dataTransfer.files?.[0]
    if (file) void uploadImage(file)
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (!productGroupId) {
      toast.error('请选择产品分组')
      return
    }
    if (isVersionMode && !product) {
      toast.error('缺少定制产品信息')
      return
    }

    startTransition(async () => {
      try {
        const versionInput = {
          product_group_id: productGroupId,
          code,
          name,
          description,
          specification,
          unit,
          image_url: imageUrl,
          quantity,
          default_unit_price: defaultUnitPrice,
          default_currency: currency,
          received_amount: receivedAmount,
        }
        const result =
          isVersionMode && product
            ? await addBusinessCustomProductVersion(
                product.custom_product_id,
                versionInput,
              )
            : await createBusinessCustomProduct({ initial_version: versionInput })

        if (!result.ok || !result.version || (!isVersionMode && !result.product)) {
          await cleanupFailedUpload()
          toast.error(
            result.error ??
              (isVersionMode ? '新增定制产品版本失败' : '创建定制产品失败'),
          )
          return
        }

        const resultProduct = result.product
        const version = result.version
        const created: BusinessCustomProductListItem = {
          custom_product_id:
            resultProduct?.id ?? product?.custom_product_id ?? '',
          is_archived: resultProduct?.is_archived ?? product?.is_archived ?? false,
          created_by: resultProduct?.created_by ?? product?.created_by ?? null,
          created_at: resultProduct?.created_at ?? product?.created_at ?? '',
          updated_by: resultProduct?.updated_by ?? product?.updated_by ?? null,
          updated_at: resultProduct?.updated_at ?? product?.updated_at ?? '',
          version_id: version.id,
          version_no: version.version_no,
          product_group_id: version.product_group_id,
          product_group_name:
            productGroups.find((group) => group.id === version.product_group_id)?.name ??
            null,
          code: version.code,
          name: version.name,
          description: version.description,
          specification: version.specification,
          unit: version.unit,
          image_url: version.image_url,
          quantity: version.quantity,
          default_unit_price: Number(version.default_unit_price),
          default_currency: version.default_currency,
          order_amount: version.order_amount == null ? null : Number(version.order_amount),
          received_amount:
            version.received_amount == null ? null : Number(version.received_amount),
          outstanding_amount:
            version.outstanding_amount == null ? null : Number(version.outstanding_amount),
        }

        await cleanupUploadedImages(imageUrl)
        onCreated(created)
        toast.success(
          isVersionMode
            ? `已创建不可变版本 v${version.version_no}`
            : context === 'order'
              ? '定制产品已创建并加入订单'
              : '定制产品已创建',
        )
        resetForm()
        setOpen(false)
      } catch {
        await cleanupFailedUpload()
        toast.error(isVersionMode ? '新增版本失败，请稍后重试' : '创建失败，请稍后重试')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant={isVersionMode ? 'outline' : context === 'order' ? 'outline' : 'default'} disabled={disabled || productGroups.length === 0}>
          <Plus className="h-4 w-4" />
          {isVersionMode ? '新增版本' : '新建定制产品'}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isVersionMode ? '创建不可变新版本' : '新建定制产品'}</DialogTitle>
          <DialogDescription>
            {isVersionMode
              ? `基于 v${product?.version_no ?? '-'} 创建新版本；旧版本及历史订单不会被修改。`
              : '定制产品创建后可供全部业务订单选择；可上传 JPEG/PNG 图片，也可填写公开图片 URL。'}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>产品分组</Label>
              <Select value={productGroupId || undefined} onValueChange={setProductGroupId}>
                <SelectTrigger><SelectValue placeholder="选择产品分组" /></SelectTrigger>
                <SelectContent>
                  {productGroups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>币种</Label>
              <Select value={currency} onValueChange={(value) => setCurrency(value as CurrencyCode)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {currencies.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${mode}_custom_product_code`}>编码</Label>
              <Input id={`${mode}_custom_product_code`} value={code} onChange={(event) => setCode(event.target.value)} maxLength={100} placeholder="可留空" />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${mode}_custom_product_name`}>名称</Label>
              <Input id={`${mode}_custom_product_name`} value={name} onChange={(event) => setName(event.target.value)} maxLength={300} required />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`${mode}_custom_product_description`}>备注</Label>
              <Textarea id={`${mode}_custom_product_description`} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4000} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`${mode}_custom_product_specification`}>规格</Label>
              <Textarea id={`${mode}_custom_product_specification`} value={specification} onChange={(event) => setSpecification(event.target.value)} maxLength={2000} />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${mode}_custom_product_unit`}>单位</Label>
              <Input id={`${mode}_custom_product_unit`} value={unit} onChange={(event) => setUnit(event.target.value)} maxLength={100} placeholder="可留空" />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${mode}_custom_product_quantity`}>数量</Label>
              <Input id={`${mode}_custom_product_quantity`} type="number" min="0.0001" step="0.0001" value={quantity} onChange={(event) => changeQuantity(event.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${mode}_custom_product_price`}>销售单价（{currency}）</Label>
              <Input id={`${mode}_custom_product_price`} type="number" min="0" step="0.01" value={defaultUnitPrice} onChange={(event) => changeUnitPrice(event.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${mode}_custom_product_order_amount`}>订单金额（{currency}）</Label>
              <Input id={`${mode}_custom_product_order_amount`} type="number" value={orderAmount} readOnly tabIndex={-1} className="bg-muted/40" />
              <p className="text-xs text-muted-foreground">数量 × 销售单价，自动计算</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${mode}_custom_product_received`}>实收金额（{currency}）</Label>
              <Input id={`${mode}_custom_product_received`} type="number" min="0" step="0.01" value={receivedAmount} onChange={(event) => changeReceivedAmount(event.target.value)} placeholder="可留空" />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${mode}_custom_product_outstanding`}>未收尾款（{currency}）</Label>
              <Input id={`${mode}_custom_product_outstanding`} type="number" step="0.01" value={outstandingAmount} onChange={(event) => changeOutstandingAmount(event.target.value)} />
              <p className="text-xs text-muted-foreground">订单金额 − 实收金额；修改后会反算实收金额</p>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`${mode}_custom_product_image`}>产品图片</Label>
              <div
                className={`rounded-md border border-dashed p-4 transition-colors ${draggingImage ? 'border-primary bg-primary/5' : 'border-input'}`}
                onDragEnter={(event) => { event.preventDefault(); setDraggingImage(true) }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDraggingImage(false)}
                onDrop={handleImageDrop}
              >
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input id={`${mode}_custom_product_image`} type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" onChange={handleImage} disabled={uploading || pending} className="sm:max-w-xs" />
                  <div className="relative flex-1">
                    <ImageIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input aria-label="产品图片 URL" type="url" value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} maxLength={2000} placeholder="或填写公开图片 URL" className="pl-9" />
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">支持拖放、选择 JPEG/PNG，单张不超过 20MB。</p>
              </div>
              {uploading && <p className="flex items-center gap-1 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在上传…</p>}
              {imageUrl && <div className="relative h-36 w-36 overflow-hidden rounded-md border bg-muted"><Image src={toImageSrc(imageUrl)} alt="定制产品图片预览" fill className="object-cover" sizes="144px" /></div>}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={pending || uploading}>取消</Button>
            <Button type="submit" disabled={pending || uploading || productGroups.length === 0}>
              {pending || uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {pending ? '保存中…' : isVersionMode ? '创建新版本' : context === 'order' ? '创建并加入订单' : '创建产品'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
