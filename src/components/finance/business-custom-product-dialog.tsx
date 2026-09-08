'use client'

import Image from 'next/image'
import { FormEvent, useRef, useState, useTransition } from 'react'
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
import type {
  BusinessCustomProductListItem,
  CurrencyCode,
  Profile,
} from '@/types'

interface BusinessCustomProductDialogProps {
  customerId: string | null
  defaultCurrency: CurrencyCode
  profileRole: Profile['role']
  disabled?: boolean
  mode?: 'create' | 'version'
  product?: BusinessCustomProductListItem
  context?: 'order' | 'library'
  onCreated: (product: BusinessCustomProductListItem) => void
}

const currencies: CurrencyCode[] = ['USD', 'EUR', 'CNY', 'GBP', 'JPY']
const MAX_IMAGE_SIZE = 5 * 1024 * 1024
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

export function BusinessCustomProductDialog({
  customerId,
  defaultCurrency,
  profileRole,
  disabled = false,
  mode = 'create',
  product,
  context = 'order',
  onCreated,
}: BusinessCustomProductDialogProps) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [specification, setSpecification] = useState('')
  const [unit, setUnit] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [defaultUnitPrice, setDefaultUnitPrice] = useState('')
  const [currency, setCurrency] = useState<CurrencyCode>(defaultCurrency)
  const [isShared, setIsShared] = useState(false)
  const uploadedPathsRef = useRef(new Set<string>())
  const { upload, uploading } = useImageUpload({
    bucket: 'product-images',
    folder: 'business-custom-products',
  })
  const canShare = profileRole === 'admin' || profileRole === 'finance'
  const isVersionMode = mode === 'version'

  function resetForm() {
    setCode(isVersionMode ? (product?.code ?? '') : '')
    setName(isVersionMode ? (product?.name ?? '') : '')
    setDescription(isVersionMode ? (product?.description ?? '') : '')
    setSpecification(isVersionMode ? (product?.specification ?? '') : '')
    setUnit(isVersionMode ? (product?.unit ?? '') : '')
    setImageUrl(isVersionMode ? (product?.image_url ?? '') : '')
    setDefaultUnitPrice(
      isVersionMode && product ? String(product.default_unit_price) : '',
    )
    setCurrency(
      isVersionMode
        ? (product?.default_currency ?? defaultCurrency)
        : defaultCurrency,
    )
    setIsShared(false)
  }

  async function cleanupUploadedImages(keepUrl?: string) {
    const keepPath = keepUrl ? productImageObjectPath(keepUrl) : null
    const paths = [...uploadedPathsRef.current].filter(
      (path) => path !== keepPath,
    )
    try {
      if (paths.length > 0) {
        const supabase = createClient()
        await supabase.storage.from('product-images').remove(paths)
      }
    } catch {
      // Cleanup is best-effort and must not hide the save result.
    } finally {
      uploadedPathsRef.current.clear()
    }
  }

  async function cleanupFailedUpload() {
    const currentUploadedPath = productImageObjectPath(imageUrl)
    const shouldClearImage =
      currentUploadedPath !== null &&
      uploadedPathsRef.current.has(currentUploadedPath)
    try {
      await cleanupUploadedImages()
    } catch {
      // Best effort: the failed product save remains the primary error.
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

  async function handleImage(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      toast.error('仅支持 JPEG 或 PNG 图片')
      return
    }
    if (file.size > MAX_IMAGE_SIZE) {
      toast.error('产品图片不能超过 5MB')
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

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (!customerId) {
      toast.error('请先选择客户')
      return
    }
    if (isVersionMode && !product) {
      toast.error('缺少定制产品信息')
      return
    }

    startTransition(async () => {
      try {
        const versionInput = {
          code,
          name,
          description,
          specification,
          unit,
          image_url: imageUrl,
          default_unit_price: defaultUnitPrice,
          default_currency: currency,
        }
        const result =
          isVersionMode && product
            ? await addBusinessCustomProductVersion(
                product.custom_product_id,
                versionInput,
              )
            : await createBusinessCustomProduct({
                customer_id: customerId,
                is_shared: canShare && isShared,
                initial_version: versionInput,
              })

        if (
          !result.ok ||
          !result.version ||
          (!isVersionMode && !result.product)
        ) {
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
          owner_customer_id:
            resultProduct?.customer_id ??
            product?.owner_customer_id ??
            customerId,
          is_shared: resultProduct?.is_shared ?? product?.is_shared ?? false,
          is_archived:
            resultProduct?.is_archived ?? product?.is_archived ?? false,
          version_id: version.id,
          version_no: version.version_no,
          code: version.code,
          name: version.name,
          description: version.description,
          specification: version.specification,
          unit: version.unit,
          image_url: version.image_url,
          default_unit_price: Number(version.default_unit_price),
          default_currency: version.default_currency,
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
        toast.error(
          isVersionMode ? '新增版本失败，请稍后重试' : '创建失败，请稍后重试',
        )
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant={
            isVersionMode
              ? 'outline'
              : context === 'order'
                ? 'outline'
                : 'default'
          }
          disabled={disabled || !customerId}
        >
          <Plus className="h-4 w-4" />
          {isVersionMode ? '新增版本' : '新建定制产品'}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isVersionMode ? '创建不可变新版本' : '新建客户定制产品'}
          </DialogTitle>
          <DialogDescription>
            {isVersionMode
              ? `基于 v${product?.version_no ?? '-'} 创建新版本；旧版本及历史订单不会被修改。`
              : '产品归属所选客户。可上传 JPEG/PNG 图片，也可保留公开图片 URL。'}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${mode}_custom_product_code`}>编码</Label>
              <Input
                id={`${mode}_custom_product_code`}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                maxLength={100}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${mode}_custom_product_name`}>名称</Label>
              <Input
                id={`${mode}_custom_product_name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={300}
                required
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`${mode}_custom_product_description`}>备注</Label>
              <Textarea
                id={`${mode}_custom_product_description`}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={4000}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`${mode}_custom_product_specification`}>
                规格
              </Label>
              <Textarea
                id={`${mode}_custom_product_specification`}
                value={specification}
                onChange={(event) => setSpecification(event.target.value)}
                maxLength={2000}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${mode}_custom_product_unit`}>单位</Label>
              <Input
                id={`${mode}_custom_product_unit`}
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                maxLength={100}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>币种</Label>
              <Select
                value={currency}
                onValueChange={(value) => setCurrency(value as CurrencyCode)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currencies.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`${mode}_custom_product_price`}>参考售价</Label>
              <Input
                id={`${mode}_custom_product_price`}
                type="number"
                min="0"
                step="0.01"
                value={defaultUnitPrice}
                onChange={(event) => setDefaultUnitPrice(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor={`${mode}_custom_product_image`}>产品图片</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id={`${mode}_custom_product_image`}
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
              <p className="text-xs text-muted-foreground">
                支持 JPEG、PNG，单张不超过 5MB。
              </p>
              {uploading && (
                <p className="flex items-center gap-1 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> 正在上传…
                </p>
              )}
              {imageUrl && (
                <div className="relative h-36 w-36 overflow-hidden rounded-md border bg-muted">
                  <Image
                    src={toImageSrc(imageUrl)}
                    alt="定制产品图片预览"
                    fill
                    className="object-cover"
                    sizes="144px"
                  />
                </div>
              )}
            </div>
            {!isVersionMode && canShare && (
              <div className="flex items-start gap-3 rounded-md border p-3 sm:col-span-2">
                <input
                  id="custom_product_shared"
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-input"
                  checked={isShared}
                  onChange={(event) => setIsShared(event.target.checked)}
                />
                <div className="space-y-1">
                  <Label htmlFor="custom_product_shared">
                    允许其他客户复用
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    开启后，其他客户的订单也能选择该定制产品；产品仍归属当前客户。
                  </p>
                </div>
              </div>
            )}
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
              {pending
                ? '保存中…'
                : isVersionMode
                  ? '创建新版本'
                  : context === 'order'
                    ? '创建并加入订单'
                    : '创建产品'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
