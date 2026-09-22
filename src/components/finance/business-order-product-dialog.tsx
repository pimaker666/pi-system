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
import { createOrderScopedProduct } from '@/lib/actions/products'
import { useImageUpload } from '@/lib/hooks/use-image-upload'
import { createClient } from '@/lib/supabase/client'
import { toImageSrc } from '@/lib/supabase/image'
import { CURRENCIES, KNOWN_CATEGORIES } from '@/schemas/product'
import type { CurrencyCode, Product, ProductGroup } from '@/types'

interface BusinessOrderProductDialogProps {
  defaultCurrency: CurrencyCode
  productGroups: ProductGroup[]
  disabled?: boolean
  triggerLabel?: string
  onCreated: (product: Product) => void
}

const NO_GROUP = '__none__'
const MAX_IMAGE_SIZE = 20 * 1024 * 1024
const PRODUCT_IMAGE_PREFIX = '/storage/v1/object/public/product-images/'

function productImageObjectPath(url: string) {
  const markerIndex = url.indexOf(PRODUCT_IMAGE_PREFIX)
  if (markerIndex < 0) return null
  const encodedPath = url.slice(markerIndex + PRODUCT_IMAGE_PREFIX.length).split(/[?#]/, 1)[0]
  try {
    return encodedPath
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
  } catch {
    return encodedPath
  }
}

export function BusinessOrderProductDialog({
  defaultCurrency,
  productGroups,
  disabled = false,
  triggerLabel = '新建普通产品',
  onCreated,
}: BusinessOrderProductDialogProps) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [specification, setSpecification] = useState('')
  const [weight, setWeight] = useState('')
  const [unit, setUnit] = useState('pcs')
  const [category, setCategory] = useState('')
  const [groupId, setGroupId] = useState('')
  const [unitPrice, setUnitPrice] = useState('')
  const [currency, setCurrency] = useState<CurrencyCode>(defaultCurrency)
  const [imageUrl, setImageUrl] = useState('')
  const [draggingImage, setDraggingImage] = useState(false)
  const uploadedPathsRef = useRef(new Set<string>())
  const { upload, uploading } = useImageUpload({
    bucket: 'product-images',
    folder: 'products',
  })

  function resetForm() {
    setName('')
    setDescription('')
    setSpecification('')
    setWeight('')
    setUnit('pcs')
    setCategory('')
    setGroupId('')
    setUnitPrice('')
    setCurrency(defaultCurrency)
    setImageUrl('')
    setDraggingImage(false)
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

  // 弹窗嵌在建单表单里，必须阻断冒泡，否则会连带提交整张订单。
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    event.stopPropagation()

    startTransition(async () => {
      try {
        const result = await createOrderScopedProduct({
          name,
          description,
          specification,
          weight_g: weight === '' ? null : Number(weight),
          unit,
          unit_price: unitPrice === '' ? 0 : Number(unitPrice),
          currency,
          image_url: imageUrl,
          category,
          group_id: groupId || null,
        })

        if (!result.ok || !result.product) {
          await cleanupFailedUpload()
          const firstFieldError = result.fieldErrors
            ? Object.values(result.fieldErrors).flat()[0]
            : undefined
          toast.error(result.error ?? firstFieldError ?? '创建产品失败')
          return
        }

        await cleanupUploadedImages(imageUrl)
        onCreated(result.product)
        toast.success('产品已创建并加入订单（产品库中默认不上架）')
        resetForm()
        setOpen(false)
      } catch {
        await cleanupFailedUpload()
        toast.error('创建失败，请稍后重试')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={disabled}>
          <Plus className="h-4 w-4" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>新建普通产品</DialogTitle>
          <DialogDescription>
            产品会同步保存到产品库，但默认不上架，因此不会出现在开具 PI 的可选范围里；业务订单可以照常选用。
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="order_product_unit">单位</Label>
              <Input
                id="order_product_unit"
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                maxLength={32}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="order_product_name">产品名称</Label>
              <Input
                id="order_product_name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={200}
                required
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="order_product_description">描述</Label>
              <Textarea
                id="order_product_description"
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={2000}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="order_product_specification">SPECIFICATION（规格）</Label>
              <Input
                id="order_product_specification"
                value={specification}
                onChange={(event) => setSpecification(event.target.value)}
                maxLength={200}
                placeholder="例如：50ml / 24pcs per box"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="order_product_weight">克重（g）</Label>
              <Input
                id="order_product_weight"
                type="number"
                min="0"
                step="0.001"
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
                placeholder="可留空"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="order_product_category">品类</Label>
              <Input
                id="order_product_category"
                list="order-product-category-options"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                maxLength={100}
                placeholder="选择或输入品类"
              />
              <datalist id="order-product-category-options">
                {KNOWN_CATEGORIES.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <Label>分组</Label>
              <Select
                value={groupId || NO_GROUP}
                onValueChange={(value) => setGroupId(value === NO_GROUP ? '' : value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择分组" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_GROUP}>未分组</SelectItem>
                  {productGroups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="order_product_price">单价（{currency}）</Label>
              <Input
                id="order_product_price"
                type="number"
                min="0"
                step="0.01"
                value={unitPrice}
                onChange={(event) => setUnitPrice(event.target.value)}
                placeholder="留空按 0 记"
              />
            </div>
            <div className="space-y-2">
              <Label>币种</Label>
              <Select value={currency} onValueChange={(value) => setCurrency(value as CurrencyCode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="order_product_image">产品图片</Label>
              <div
                className={`rounded-md border border-dashed p-4 transition-colors ${draggingImage ? 'border-primary bg-primary/5' : 'border-input'}`}
                onDragEnter={(event) => {
                  event.preventDefault()
                  setDraggingImage(true)
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDraggingImage(false)}
                onDrop={handleImageDrop}
              >
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="order_product_image"
                    type="file"
                    accept=".jpg,.jpeg,.png,image/jpeg,image/png"
                    onChange={handleImage}
                    disabled={uploading || pending}
                    className="sm:max-w-xs"
                  />
                  <div className="relative flex-1">
                    <ImageIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      aria-label="产品图片 URL"
                      type="url"
                      value={imageUrl}
                      onChange={(event) => setImageUrl(event.target.value)}
                      maxLength={2000}
                      placeholder="或填写公开图片 URL"
                      className="pl-9"
                    />
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  支持拖放、选择 JPEG/PNG，单张不超过 20MB。
                </p>
              </div>
              {uploading && (
                <p className="flex items-center gap-1 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在上传…
                </p>
              )}
              {imageUrl && (
                <div className="relative h-36 w-36 overflow-hidden rounded-md border bg-muted">
                  <Image
                    src={toImageSrc(imageUrl)}
                    alt="产品图片预览"
                    fill
                    className="object-cover"
                    sizes="144px"
                  />
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={pending || uploading}
            >
              取消
            </Button>
            <Button type="submit" disabled={pending || uploading}>
              {pending || uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {pending ? '保存中…' : '创建并加入订单'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
