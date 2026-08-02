'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import Image from 'next/image'
import { productSchema, type ProductInput, CURRENCIES } from '@/schemas/product'
import { createProduct, updateProduct } from '@/lib/actions/products'
import { useImageUpload } from '@/lib/hooks/use-image-upload'
import { toImageSrc } from '@/lib/supabase/image'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Product, ProductGroup } from '@/types'

const NO_GROUP = '__none__'

export function ProductForm({
  product,
  groups = [],
  categories = [],
}: {
  product?: Product
  groups?: ProductGroup[]
  categories?: string[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [imageUrl, setImageUrl] = useState(product?.image_url ?? '')
  const { upload, uploading } = useImageUpload({ bucket: 'product-images' })

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ProductInput>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      sku: product?.sku ?? '',
      name: product?.name ?? '',
      description: product?.description ?? '',
      specification: product?.specification ?? '',
      weight_g: product?.weight_g ?? undefined,
      unit: product?.unit ?? 'pcs',
      unit_price: product?.unit_price ?? 0,
      currency: product?.currency ?? 'USD',
      image_url: product?.image_url ?? '',
      category: product?.category ?? '',
      group_id: product?.group_id ?? '',
      is_active: product?.is_active ?? true,
    },
  })

  const currency = watch('currency')
  const groupId = watch('group_id')
  const isActive = watch('is_active')

  async function handleImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const url = await upload(file)
      setImageUrl(url)
      setValue('image_url', url)
      toast.success('图片已上传')
    } catch {
      toast.error('图片上传失败')
    }
  }

  function onSubmit(values: ProductInput) {
    const fd = new FormData()
    Object.entries(values).forEach(([k, v]) => fd.append(k, String(v ?? '')))
    startTransition(async () => {
      const result = product
        ? await updateProduct(product.id, fd)
        : await createProduct(fd)
      if (result.ok) {
        toast.success(product ? '产品已更新' : '产品已创建')
        router.push('/products')
        router.refresh()
      } else {
        toast.error(result.error ?? '保存失败')
      }
    })
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-2xl space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="sku">SKU</Label>
          <Input id="sku" {...register('sku')} />
          {errors.sku && <p className="text-sm text-destructive">{errors.sku.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="unit">单位</Label>
          <Input id="unit" {...register('unit')} />
          {errors.unit && <p className="text-sm text-destructive">{errors.unit.message}</p>}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="name">产品名称</Label>
        <Input id="name" {...register('name')} />
        {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">描述</Label>
        <Textarea id="description" rows={3} {...register('description')} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="specification">SPECIFICATION（规格）</Label>
          <Input id="specification" placeholder="例如：50ml / 24pcs per box" {...register('specification')} />
          {errors.specification && (
            <p className="text-sm text-destructive">{errors.specification.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="weight_g">克重（g）</Label>
          <Input
            id="weight_g"
            type="number"
            step="0.001"
            min={0}
            placeholder="例如：500（留空表示未填）"
            {...register('weight_g')}
          />
          {errors.weight_g && (
            <p className="text-sm text-destructive">{errors.weight_g.message}</p>
          )}
          <p className="text-xs text-muted-foreground">默认不出现在 PI 中，仅用于计算重量。</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="category">品类</Label>
          <Input id="category" list="category-options" placeholder="选择或输入品类" {...register('category')} />
          <datalist id="category-options">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div className="space-y-2">
          <Label>分组</Label>
          <Select
            value={groupId ? groupId : NO_GROUP}
            onValueChange={(v) => setValue('group_id', v === NO_GROUP ? '' : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="选择分组" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_GROUP}>未分组</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="unit_price">单价</Label>
          <Input id="unit_price" type="number" step="0.01" {...register('unit_price')} />
          {errors.unit_price && (
            <p className="text-sm text-destructive">{errors.unit_price.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label>币种</Label>
          <Select value={currency} onValueChange={(v) => setValue('currency', v as ProductInput['currency'])}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="image">产品图片</Label>
        <Input id="image" type="file" accept="image/*" onChange={handleImage} disabled={uploading} />
        {uploading && <p className="text-sm text-muted-foreground">上传中…</p>}
        {imageUrl && (
          <div className="relative mt-2 h-32 w-32 overflow-hidden rounded-md border">
            <Image src={toImageSrc(imageUrl)} alt="预览" fill className="object-cover" sizes="128px" />
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setValue('is_active', e.target.checked)}
          className="h-4 w-4"
        />
        上架（可用于开 PI）
      </label>

      <div className="flex gap-3">
        <Button type="submit" disabled={pending || uploading}>
          {pending ? '保存中…' : '保存'}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          取消
        </Button>
      </div>
    </form>
  )
}
