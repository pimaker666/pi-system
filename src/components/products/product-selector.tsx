'use client'

import { useMemo, useRef, useState, useEffect, useLayoutEffect } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  Search,
  Plus,
  Minus,
  Trash2,
  ImageIcon,
  Upload,
  Loader2,
  X,
  GripVertical,
  ChevronUp,
  ChevronDown,
} from 'lucide-react'
import { usePiCartStore } from '@/stores/pi-cart-store'
import { useImageUpload } from '@/lib/hooks/use-image-upload'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ImagePreview } from '@/components/ui/image-preview'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatCurrency, cn } from '@/lib/utils'
import { calcLineTotal } from '@/lib/calc'
import { toImageSrc } from '@/lib/supabase/image'
import {
  saveImageVariantProduct,
  syncVariantProductFields,
} from '@/lib/actions/products'
import type { PiLineItem, Product, ProductGroup } from '@/types'

const ALL_GROUPS = '__all__'
const NO_GROUP = '__none__'

/** useLayoutEffect on the client, useEffect on the server (avoids SSR warning). */
const useIsoLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect

/** 48px product thumbnail with a hover overlay to replace the image locally. */
function LineImageThumb({
  src,
  alt,
  onChange,
}: {
  src: string | null
  alt: string
  onChange: (url: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const { upload, uploading } = useImageUpload({
    bucket: 'product-images',
    folder: 'pi-overrides',
  })

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      try {
        const url = await upload(file)
        onChange(url)
      } catch {
        /* error surfaced via hook state; ignore here */
      }
    }
    e.target.value = ''
  }

  return (
    <div className="group relative h-12 w-12 shrink-0 overflow-hidden rounded border bg-muted">
      {src ? (
        <Image src={toImageSrc(src)} alt={alt} fill className="object-cover" sizes="48px" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <ImageIcon className="h-5 w-5" />
        </div>
      )}
      <button
        type="button"
        title="替换图片"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="absolute inset-0 flex items-center justify-center bg-black/45 text-white opacity-0 transition group-hover:opacity-100"
      >
        {uploading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Upload className="h-4 w-4" />
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFile}
      />
    </div>
  )
}

/** Remark image upload: a preview with remove, or an upload trigger button. */
function RemarkImage({
  src,
  onChange,
}: {
  src: string | null
  onChange: (url: string | null) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const { upload, uploading } = useImageUpload({
    bucket: 'product-images',
    folder: 'pi-remarks',
  })

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      try {
        const url = await upload(file)
        onChange(url)
      } catch {
        /* error surfaced via hook state; ignore here */
      }
    }
    e.target.value = ''
  }

  return (
    <div className="flex items-center gap-2">
      {src ? (
        <div className="group relative h-16 w-16 shrink-0 overflow-hidden rounded border bg-muted">
          <Image src={toImageSrc(src)} alt="备注图片" fill className="object-cover" sizes="64px" />
          <button
            type="button"
            title="移除图片"
            onClick={() => onChange(null)}
            className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition group-hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="mr-1 h-3.5 w-3.5" />
          )}
          上传备注图片
        </Button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFile}
      />
    </div>
  )
}

export function ProductSelector({
  products,
  groups = [],
}: {
  products: Product[]
  groups?: ProductGroup[]
}) {
  const [query, setQuery] = useState('')
  const [groupFilter, setGroupFilter] = useState(ALL_GROUPS)
  const [bulkQty, setBulkQty] = useState('')
  const [bulkPrice, setBulkPrice] = useState('')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const itemElsRef = useRef<Record<string, HTMLDivElement | null>>({})
  const scrollTargetRef = useRef<string | null>(null)
  const prevTopRef = useRef(0)
  const {
    items,
    currency,
    addProduct,
    removeLine,
    reorderItem,
    setQuantity,
    setUnitPrice,
    setAllQuantity,
    setAllUnitPrice,
    setName,
    setDescription,
    setImage,
    setRemarkImage,
    setSpecification,
    linkLineToProduct,
    countOf,
  } = usePiCartStore()
  const router = useRouter()

  // Move a selected item up (dir=-1) or down (dir=1) via the arrow buttons,
  // then keep it at the same on-screen position so the cursor stays over its
  // buttons for repeated clicks.
  function moveItem(index: number, dir: -1 | 1, lineId: string) {
    const el = itemElsRef.current[lineId]
    prevTopRef.current = el ? el.getBoundingClientRect().top : 0
    scrollTargetRef.current = lineId
    reorderItem(index, index + dir)
  }

  useIsoLayoutEffect(() => {
    const id = scrollTargetRef.current
    if (!id) return
    scrollTargetRef.current = null
    const el = itemElsRef.current[id]
    const container = listRef.current
    if (el && container) {
      const delta = el.getBoundingClientRect().top - prevTopRef.current
      if (delta) container.scrollTop += delta
    }
  }, [items])

  // 换图 → 行内立即生效，并自动把该行存为产品库新产品（SKU 自动加后缀）。
  // 该行已入过库则只更新那个变体产品的图片。
  async function handleImageChange(item: PiLineItem, url: string) {
    setImage(item.line_id, url)
    try {
      const res = await saveImageVariantProduct({
        source_product_id: item.auto_saved_product ? null : item.product_id,
        existing_variant_id: item.auto_saved_product ? item.product_id : null,
        name: item.name,
        specification: item.specification,
        image_url: url,
      })
      if (res.ok && res.id && res.sku) {
        linkLineToProduct(item.line_id, res.id, res.sku)
        toast.success(
          item.auto_saved_product
            ? `已更新新产品 ${res.sku} 的图片`
            : `换图产品已自动存入产品库：${res.sku}`,
        )
        router.refresh()
      } else if (!res.ok) {
        toast.error(`图片已替换，但自动入库失败：${res.error ?? '未知错误'}`)
      }
    } catch {
      toast.error('图片已替换，但自动入库失败，请稍后在产品库手动添加')
    }
  }

  // 换图入库后的行：名称/规格失焦时同步到变体产品。
  function syncLineFields(
    item: PiLineItem,
    patch: { name?: string; specification?: string | null },
  ) {
    if (!item.auto_saved_product || !item.product_id) return
    syncVariantProductFields(item.product_id, patch)
      .then((res) => {
        if (!res.ok) toast.error(`同步到新产品失败：${res.error}`)
      })
      .catch(() => toast.error('同步到新产品失败'))
  }

  const groupName = useMemo(
    () => new Map(groups.map((g) => [g.id, g.name])),
    [groups],
  )

  const groupOrder = useMemo(
    () => new Map(groups.map((g, index) => [g.id, index])),
    [groups],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = products.filter((p) => {
      const matchQuery =
        !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)
      const matchGroup =
        groupFilter === ALL_GROUPS ||
        (groupFilter === NO_GROUP ? !p.group_id : p.group_id === groupFilter)
      return matchQuery && matchGroup
    })
    const orderOf = (p: Product) =>
      p.group_id && groupOrder.has(p.group_id)
        ? (groupOrder.get(p.group_id) as number)
        : Number.MAX_SAFE_INTEGER
    return matched.sort((a, b) => {
      const diff = orderOf(a) - orderOf(b)
      if (diff !== 0) return diff
      return a.name.localeCompare(b.name)
    })
  }, [products, query, groupFilter, groupOrder])

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索产品名称或 SKU"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={groupFilter} onValueChange={setGroupFilter}>
            <SelectTrigger className="sm:w-44">
              <SelectValue placeholder="全部分组" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_GROUPS}>全部分组</SelectItem>
              <SelectItem value={NO_GROUP}>未分组</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
          {filtered.map((p) => {
            const disabled = items.length > 0 && p.currency !== currency
            const count = countOf(p.id)
            return (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-md border p-3"
              >
                <ImagePreview
                  src={p.image_url}
                  alt={p.name}
                  size="h-12 w-12"
                  sizes="48px"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {p.sku} · {formatCurrency(p.unit_price, p.currency)} / {p.unit}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    {p.group_id && groupName.has(p.group_id) ? (
                      <Badge variant="outline" className="text-[10px]">
                        {groupName.get(p.group_id)}
                      </Badge>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">未分组</span>
                    )}
                    {count > 0 && (
                      <Badge variant="secondary" className="text-[10px]">
                        已加 {count} 行
                      </Badge>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={count > 0 ? 'secondary' : 'default'}
                  disabled={disabled}
                  onClick={() => addProduct(p)}
                >
                  {disabled ? '币种不符' : count > 0 ? '再加一行' : '加入'}
                </Button>
              </div>
            )
          })}
          {filtered.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">没有匹配的产品</p>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <h3 className="font-medium">已选产品</h3>
            {items.length > 1 && (
              <span className="text-xs text-muted-foreground">
                拖动 <GripVertical className="inline h-3 w-3 align-text-bottom" /> 或点 ▲▼ 调整顺序
              </span>
            )}
          </div>
          {items.length > 0 && <Badge variant="secondary">{currency}</Badge>}
        </div>

        {items.length > 0 && (
          <div className="rounded-md border bg-muted/40 p-2">
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">
              批量设置（应用到全部已选产品）
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="flex flex-1 items-center gap-1">
                <Input
                  type="number"
                  min={1}
                  value={bulkQty}
                  placeholder="统一数量"
                  onChange={(e) => setBulkQty(e.target.value)}
                  className="h-8"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() =>
                    setAllQuantity(bulkQty === '' ? null : Number(bulkQty))
                  }
                >
                  应用
                </Button>
              </div>
              <div className="flex flex-1 items-center gap-1">
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  value={bulkPrice}
                  placeholder={`统一单价 (${currency})`}
                  onChange={(e) => setBulkPrice(e.target.value)}
                  className="h-8"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() =>
                    setAllUnitPrice(bulkPrice === '' ? null : Number(bulkPrice))
                  }
                >
                  应用
                </Button>
              </div>
            </div>
          </div>
        )}

        {items.length === 0 ? (
          <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            从左侧选择产品加入 PI
          </p>
        ) : (
          <div ref={listRef} className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
            {items.map((item, index) => (
              <div
                key={item.line_id}
                ref={(el) => {
                  itemElsRef.current[item.line_id] = el
                }}
                onDragOver={(e) => {
                  if (dragIndex === null) return
                  e.preventDefault()
                  if (overIndex !== index) setOverIndex(index)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragIndex !== null) reorderItem(dragIndex, index)
                  setDragIndex(null)
                  setOverIndex(null)
                }}
                className={cn(
                  'rounded-md border p-3 transition',
                  dragIndex === index && 'opacity-50',
                  overIndex === index &&
                    dragIndex !== null &&
                    dragIndex !== index &&
                    'border-primary ring-2 ring-primary/40',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    <div className="mt-1 flex shrink-0 flex-col items-center">
                      <button
                        type="button"
                        draggable
                        onDragStart={(e) => {
                          setDragIndex(index)
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => {
                          setDragIndex(null)
                          setOverIndex(null)
                        }}
                        title="拖动调整顺序"
                        className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
                      >
                        <GripVertical className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveItem(index, -1, item.line_id)}
                        disabled={index === 0}
                        title="上移"
                        className="text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <ChevronUp className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveItem(index, 1, item.line_id)}
                        disabled={index === items.length - 1}
                        title="下移"
                        className="text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <ChevronDown className="h-4 w-4" />
                      </button>
                    </div>
                    <LineImageThumb
                      src={item.image_url}
                      alt={item.name}
                      onChange={(url) => handleImageChange(item, url)}
                    />
                    <div className="min-w-0 flex-1">
                      <Input
                        value={item.name}
                        onChange={(e) => setName(item.line_id, e.target.value)}
                        onBlur={(e) => syncLineFields(item, { name: e.target.value })}
                        placeholder="产品名称"
                        className="h-8 font-medium"
                      />
                      <div className="mt-1 text-xs text-muted-foreground">
                        {item.sku} ·{' '}
                        {item.auto_saved_product
                          ? '换图后已自动存为产品库新产品'
                          : '仅本 PI 显示，不影响产品库'}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => removeLine(item.line_id)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">单价 ({item.currency})</label>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={item.unit_price ?? ''}
                      placeholder="填写单价"
                      onChange={(e) =>
                        setUnitPrice(
                          item.line_id,
                          e.target.value === '' ? null : Number(e.target.value),
                        )
                      }
                      className="h-8"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">数量</label>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="outline"
                        className="h-8 w-8 shrink-0"
                        onClick={() => setQuantity(item.line_id, (item.quantity ?? 0) - 1)}
                      >
                        <Minus className="h-3 w-3" />
                      </Button>
                      <Input
                        type="number"
                        min={1}
                        value={item.quantity ?? ''}
                        placeholder="数量"
                        onChange={(e) =>
                          setQuantity(
                            item.line_id,
                            e.target.value === '' ? null : Number(e.target.value),
                          )
                        }
                        className="h-8 text-center"
                      />
                      <Button
                        size="icon"
                        variant="outline"
                        className="h-8 w-8 shrink-0"
                        onClick={() => setQuantity(item.line_id, (item.quantity ?? 0) + 1)}
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="mt-2 space-y-1">
                  <label className="text-xs text-muted-foreground">SPECIFICATION（显示在 PI 该行）</label>
                  <Input
                    value={item.specification ?? ''}
                    onChange={(e) =>
                      setSpecification(
                        item.line_id,
                        e.target.value === '' ? null : e.target.value,
                      )
                    }
                    onBlur={(e) =>
                      syncLineFields(item, {
                        specification: e.target.value === '' ? null : e.target.value,
                      })
                    }
                    placeholder="规格，例如 50ml / 24pcs per box"
                    className="h-8"
                  />
                </div>

                <div className="mt-2 space-y-1">
                  <label className="text-xs text-muted-foreground">备注（显示在 PI 该行）</label>
                  <Input
                    value={item.description ?? ''}
                    onChange={(e) => setDescription(item.line_id, e.target.value)}
                    placeholder="例如规格、包装、交期等"
                    className="h-8"
                  />
                  <RemarkImage
                    src={item.remark_image_url}
                    onChange={(url) => setRemarkImage(item.line_id, url)}
                  />
                </div>

                <div className="mt-2 text-right text-sm font-medium">
                  小计：
                  {formatCurrency(calcLineTotal(item.unit_price, item.quantity), item.currency)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
