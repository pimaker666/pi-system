'use client'

import {
  type ChangeEvent,
  type DragEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { ImageIcon, ListPlus, Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
  addBusinessCustomProductVersion,
  appendBusinessOrderItems,
  createBusinessCustomProduct,
  listBusinessCustomProducts,
  listBusinessOrderAppendCatalog,
} from '@/lib/actions/business-orders'
import { useImageUpload } from '@/lib/hooks/use-image-upload'
import {
  businessOrderItemDisplayName,
  businessOrderItemDisplaySku,
} from '@/lib/business-order-financials'
import { createClient } from '@/lib/supabase/client'
import { toImageSrc } from '@/lib/supabase/image'
import { formatCurrency } from '@/lib/utils'
import type {
  BusinessCustomProduct,
  BusinessCustomProductListItem,
  BusinessCustomProductVersion,
  BusinessOrderItem,
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

const CURRENCY_OPTIONS: CurrencyCode[] = ['USD', 'EUR', 'CNY', 'GBP', 'JPY']
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

interface CustomFields {
  groupId: string
  code: string
  name: string
  description: string
  specification: string
  unit: string
  imageUrl: string
  currency: CurrencyCode
}

interface AppendRow {
  key: string
  sourceType: 'catalog' | 'custom'
  productId: string
  linkedCustom: BusinessCustomProductListItem | null
  custom: CustomFields
  quantity: string
  unitPrice: string
  receivedAmount: string
  outstandingAmount: string
  dailyShippingCategory: DailyOrderShippingCategory
}

function emptyCustomFields(orderCurrency: CurrencyCode): CustomFields {
  return {
    groupId: '',
    code: '',
    name: '',
    description: '',
    specification: '',
    unit: '',
    imageUrl: '',
    currency: orderCurrency,
  }
}

function emptyRow(
  sourceType: 'catalog' | 'custom',
  orderCurrency: CurrencyCode,
): AppendRow {
  return {
    key: newRowKey(),
    sourceType,
    productId: '',
    linkedCustom: null,
    custom: emptyCustomFields(orderCurrency),
    quantity: '',
    unitPrice: '',
    receivedAmount: '',
    outstandingAmount: '0',
    dailyShippingCategory: 'stock',
  }
}

function customFieldsFromProduct(product: BusinessCustomProductListItem): CustomFields {
  return {
    groupId: product.product_group_id ?? '',
    code: product.code,
    name: product.name,
    description: product.description ?? '',
    specification: product.specification ?? '',
    unit: product.unit,
    imageUrl: product.image_url ?? '',
    currency: product.default_currency,
  }
}

// 仅比对产品资料字段：数量/单价/实收属于订单行数据，改动不产生新版本。
function customIdentityModified(linked: BusinessCustomProductListItem, fields: CustomFields) {
  return (
    (linked.product_group_id ?? '') !== fields.groupId ||
    linked.code !== fields.code ||
    linked.name !== fields.name ||
    (linked.description ?? '') !== fields.description ||
    (linked.specification ?? '') !== fields.specification ||
    linked.unit !== fields.unit ||
    (linked.image_url ?? '') !== fields.imageUrl ||
    linked.default_currency !== fields.currency
  )
}

// 定制产品行无法在定制产品库中匹配到版本时（如已归档删除），用订单快照兜底，
// 保证不改资料时仍复用原版本引用；version_no=0 表示来自订单快照。
function buildCustomItemFromOrderItem(
  item: BusinessOrderItem,
  orderCurrency: CurrencyCode,
): BusinessCustomProductListItem {
  return {
    custom_product_id: item.custom_product_id ?? '',
    is_archived: false,
    created_by: null,
    created_at: item.created_at,
    updated_by: null,
    updated_at: item.created_at,
    version_id: item.custom_product_version_id ?? '',
    version_no: 0,
    product_group_id: '',
    product_group_name: null,
    code: item.sku_snapshot,
    name: item.name_snapshot,
    description: item.description_snapshot ?? '',
    specification: item.specification_snapshot ?? '',
    unit: item.unit_snapshot,
    image_url: item.image_url_snapshot ?? '',
    quantity: item.quantity,
    default_unit_price: Number(item.unit_price),
    default_currency: orderCurrency,
    order_amount: null,
    received_amount:
      item.product_received_amount == null ? null : Number(item.product_received_amount),
    outstanding_amount: null,
  }
}

function ItemThumb({ src, alt }: { src: string | null | undefined; alt: string }) {
  const imgSrc = toImageSrc(src)
  return (
    <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded border bg-muted">
      {imgSrc ? (
        <Image src={imgSrc} alt={alt} fill className="object-cover" sizes="40px" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <ImageIcon className="h-4 w-4" />
        </div>
      )}
    </div>
  )
}

interface BusinessOrderAppendDialogProps {
  orderId: string
  orderVersion: number
  currency: CurrencyCode
  hasDailyFields: boolean
  orderItems: BusinessOrderItem[]
  needsReapproval?: boolean
}

export function BusinessOrderAppendDialog({
  orderId,
  orderVersion,
  currency,
  hasDailyFields,
  orderItems,
  needsReapproval = false,
}: BusinessOrderAppendDialogProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [catalog, setCatalog] = useState<{
    products: Product[]
    productGroups: ProductGroup[]
  } | null>(null)
  const [customProducts, setCustomProducts] = useState<BusinessCustomProductListItem[] | null>(null)
  const [rows, setRows] = useState<AppendRow[]>(() => [emptyRow('catalog', currency)])
  const [reason, setReason] = useState('')
  const [draggingImageKey, setDraggingImageKey] = useState<string | null>(null)
  const uploadedUrlsRef = useRef(new Set<string>())
  const persistedUrlsRef = useRef(new Set<string>())
  const { upload, uploading } = useImageUpload({
    bucket: 'product-images',
    folder: 'business-custom-products',
  })

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

  useEffect(() => {
    if (!open || customProducts !== null) return
    let active = true
    listBusinessCustomProducts()
      .then((result) => {
        if (!active) return
        // 读取失败不阻断加单：导入定制产品时退回订单快照兜底。
        setCustomProducts(result.ok ? (result.data ?? []) : [])
      })
      .catch(() => {
        if (active) setCustomProducts([])
      })
    return () => {
      active = false
    }
  }, [open, customProducts])

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
        financial_product_name: product.financial_product_name,
      })),
    [catalog],
  )

  const importableItems = useMemo(() => {
    const seen = new Set<string>()
    const list: BusinessOrderItem[] = []
    for (const item of orderItems) {
      if (item.source_type === 'legacy') continue
      if (item.source_type === 'catalog' && !item.product_id) continue
      if (item.source_type === 'custom' && !item.custom_product_id) continue
      const key =
        item.source_type === 'custom'
          ? `custom:${item.custom_product_id}`
          : `catalog:${item.product_id}`
      if (seen.has(key)) continue
      seen.add(key)
      list.push(item)
    }
    return list
  }, [orderItems])

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

  function updateCustom(key: string, patch: Partial<CustomFields>) {
    setRows((current) =>
      current.map((row) =>
        row.key === key ? { ...row, custom: { ...row.custom, ...patch } } : row,
      ),
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

  function switchSourceType(key: string, sourceType: AppendRow['sourceType']) {
    setRows((current) =>
      current.map((row) => {
        if (row.key !== key || row.sourceType === sourceType) return row
        if (sourceType === 'catalog') {
          return { ...row, sourceType, productId: '', linkedCustom: null, custom: emptyCustomFields(currency) }
        }
        return { ...row, sourceType, productId: '' }
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

  function handleCustomProductSelect(key: string, product: BusinessCustomProductListItem | null) {
    setRows((current) =>
      current.map((row) => {
        if (row.key !== key) return row
        const quantity = product ? (product.quantity == null ? '' : String(product.quantity)) : ''
        const unitPrice =
          product && product.default_currency === currency ? String(product.default_unit_price) : ''
        const receivedAmount =
          product && product.received_amount != null ? String(product.received_amount) : ''
        return {
          ...row,
          linkedCustom: product,
          custom: product ? customFieldsFromProduct(product) : emptyCustomFields(currency),
          quantity,
          unitPrice,
          receivedAmount,
          outstandingAmount: derivedOutstanding(quantity, unitPrice, receivedAmount),
        }
      }),
    )
  }

  function importOrderItem(item: BusinessOrderItem) {
    if (item.source_type === 'catalog' && item.product_id) {
      // 产品列表只含在售产品；导入停用产品时选择框会显示为空，提示用户留意。
      if (catalog && !catalog.products.some((product) => product.id === item.product_id)) {
        toast.warning('该产品已不在可选产品列表（可能已停用），可保持原样提交或重新选择')
      }
      const row = emptyRow('catalog', currency)
      row.productId = item.product_id
      row.quantity = String(item.quantity)
      row.unitPrice = String(item.unit_price)
      row.outstandingAmount = derivedOutstanding(row.quantity, row.unitPrice, row.receivedAmount)
      setRows((current) => [...current, row])
      return
    }
    if (item.source_type === 'custom' && item.custom_product_id && item.custom_product_version_id) {
      const matched =
        (customProducts ?? []).find((p) => p.version_id === item.custom_product_version_id) ?? null
      const base = matched ?? buildCustomItemFromOrderItem(item, currency)
      const row = emptyRow('custom', currency)
      row.linkedCustom = base
      row.custom = customFieldsFromProduct(base)
      row.quantity = String(item.quantity)
      row.unitPrice = String(item.unit_price)
      row.receivedAmount = base.received_amount == null ? '' : String(base.received_amount)
      row.outstandingAmount = derivedOutstanding(row.quantity, row.unitPrice, row.receivedAmount)
      setRows((current) => [...current, row])
    }
  }

  async function cleanupUploadedImages() {
    const orphanUrls = [...uploadedUrlsRef.current].filter(
      (url) => !persistedUrlsRef.current.has(url),
    )
    const paths = orphanUrls
      .map((url) => productImageObjectPath(url))
      .filter((path): path is string => path !== null)
    try {
      if (paths.length > 0) {
        const supabase = createClient()
        await supabase.storage.from('product-images').remove(paths)
      }
    } finally {
      uploadedUrlsRef.current.clear()
      persistedUrlsRef.current.clear()
    }
  }

  async function uploadImageForRow(key: string, file: File) {
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
      uploadedUrlsRef.current.add(url)
      updateCustom(key, { imageUrl: url })
      toast.success('图片已上传')
    } catch {
      toast.error('图片上传失败，请稍后重试')
    }
  }

  function handleImageFile(key: string, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void uploadImageForRow(key, file)
  }

  function handleImageDrop(key: string, event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDraggingImageKey((current) => (current === key ? null : current))
    const file = event.dataTransfer.files?.[0]
    if (file) void uploadImageForRow(key, file)
  }

  function closeDialog() {
    if (pending || uploading) return
    setOpen(false)
    void cleanupUploadedImages()
    setRows([emptyRow('catalog', currency)])
    setReason('')
  }

  function handleSubmit() {
    const items: Array<
      | { source_type: 'catalog'; product_id: string; quantity: number; unit_price: number }
      | {
          source_type: 'custom'
          custom_product_id: string
          custom_product_version_id: string
          quantity: number
          unit_price: number
        }
    > = []
    const customTasks: Array<{
      rowKey: string
      create: boolean
      linked: BusinessCustomProductListItem | null
      draft: {
        product_group_id: string
        code: string
        name: string
        description: string
        specification: string
        unit: string
        image_url: string
        quantity: string
        default_unit_price: string
        default_currency: CurrencyCode
        received_amount: string
      }
    }> = []

    for (const row of rows) {
      const quantity = Number(row.quantity)
      const unitPrice = Number(row.unitPrice)
      if (!Number.isFinite(quantity) || quantity <= 0) {
        toast.error('追加数量必须大于 0')
        return
      }
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        toast.error('成交单价不能为负')
        return
      }

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
        const needsPersist = !row.linkedCustom || customIdentityModified(row.linkedCustom, row.custom)
        if (needsPersist) {
          if (!row.custom.groupId) {
            toast.error('定制产品行请先选择产品分组')
            return
          }
          if (!row.custom.name.trim()) {
            toast.error('请填写定制产品名称')
            return
          }
        }
        customTasks.push({
          rowKey: row.key,
          create: !row.linkedCustom,
          linked: row.linkedCustom,
          draft: {
            product_group_id: row.custom.groupId,
            code: row.custom.code,
            name: row.custom.name,
            description: row.custom.description,
            specification: row.custom.specification,
            unit: row.custom.unit,
            image_url: row.custom.imageUrl,
            quantity: row.quantity,
            default_unit_price: row.unitPrice,
            default_currency: row.custom.currency,
            received_amount: row.receivedAmount,
          },
        })
        items.push({
          source_type: 'custom' as const,
          custom_product_id: row.linkedCustom?.custom_product_id ?? '',
          custom_product_version_id: row.linkedCustom?.version_id ?? '',
          quantity,
          unit_price: unitPrice,
        })
      }

      if (hasDailyFields) {
        const lineAmount = roundMoney(quantity * unitPrice)
        const productReceived =
          row.receivedAmount === '' ? 0 : roundMoney(Number(row.receivedAmount))
        if (!Number.isFinite(productReceived) || productReceived < 0) {
          toast.error('实收金额不能为负')
          return
        }
        Object.assign(items[items.length - 1], {
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
      const resolved = new Map<
        string,
        { productId: string; product: BusinessCustomProduct | null; version: BusinessCustomProductVersion }
      >()
      try {
        for (const task of customTasks) {
          const result = task.create
            ? await createBusinessCustomProduct({ initial_version: task.draft })
            : await addBusinessCustomProductVersion(task.linked?.custom_product_id ?? '', task.draft)
          if (!result.ok || !result.version || (task.create && !result.product)) {
            toast.error(
              result.error ?? (task.create ? '创建定制产品失败' : '新增定制产品版本失败'),
            )
            return
          }
          if (task.draft.image_url) persistedUrlsRef.current.add(task.draft.image_url)
          resolved.set(task.rowKey, {
            productId: task.create
              ? (result.product as BusinessCustomProduct).id
              : (task.linked as BusinessCustomProductListItem).custom_product_id,
            product: task.create ? (result.product ?? null) : null,
            version: result.version,
          })
        }

        rows.forEach((row, index) => {
          const entry = resolved.get(row.key)
          if (!entry) return
          const item = items[index] as {
            source_type: 'custom'
            custom_product_id: string
            custom_product_version_id: string
          }
          item.custom_product_id = entry.productId
          item.custom_product_version_id = entry.version.id
        })

        // 追加失败重试时直接复用已创建的产品/版本，避免重复建档。
        setRows((current) =>
          current.map((row) => {
            const entry = resolved.get(row.key)
            if (!entry) return row
            const version = entry.version
            return {
              ...row,
              linkedCustom: {
                custom_product_id: entry.productId,
                is_archived: entry.product?.is_archived ?? false,
                created_by: entry.product?.created_by ?? null,
                created_at: entry.product?.created_at ?? version.created_at,
                updated_by: entry.product?.updated_by ?? null,
                updated_at: entry.product?.updated_at ?? version.created_at,
                version_id: version.id,
                version_no: version.version_no,
                product_group_id: version.product_group_id,
                product_group_name:
                  (catalog?.productGroups ?? []).find((g) => g.id === version.product_group_id)
                    ?.name ?? null,
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
              },
              custom: {
                groupId: version.product_group_id ?? '',
                code: version.code,
                name: version.name,
                description: version.description ?? '',
                specification: version.specification ?? '',
                unit: version.unit,
                imageUrl: version.image_url ?? '',
                currency: version.default_currency,
              },
            }
          }),
        )

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
        await cleanupUploadedImages()
        setOpen(false)
        setRows([emptyRow('catalog', currency)])
        setReason('')
        router.refresh()
      } catch {
        toast.error('追加产品失败，请稍后重试')
      }
    })
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        追加产品
      </Button>
      <Dialog open={open} onOpenChange={(next) => { if (!next) closeDialog() }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>追加产品（加单）</DialogTitle>
            <DialogDescription>
              可直接追加产品明细，追加后订单应收金额会相应增加，并记录加单审计。
              {' '}定制产品行与「新建定制产品」字段一致，修改资料后提交时会保存为新的不可变版本。
              {' '}也可导入本订单已有产品继续追加。
              {needsReapproval && ' 订单将重新进入待审核状态，由管理员确认后生效收款发货。'}
              {' '}同一产品多次追加会各自新增一行，不会覆盖历史下单数据。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {rows.map((row) =>
              row.sourceType === 'catalog' ? (
                <div key={row.key} className="space-y-3 rounded-md border-2 border-slate-300 p-3 shadow-sm dark:border-slate-700">
                  <div className="grid grid-cols-2 items-end gap-3 xl:grid-cols-[130px_minmax(0,1fr)_110px_130px_40px]">
                    <div className="space-y-1">
                      <Label>类型</Label>
                      <Select
                        value={row.sourceType}
                        onValueChange={(value) => switchSourceType(row.key, value as AppendRow['sourceType'])}
                        disabled={pending}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="catalog">普通产品</SelectItem>
                          <SelectItem value="custom">定制产品</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label>产品</Label>
                      <ProductCombobox
                        products={productOptions}
                        productGroups={catalog?.productGroups ?? []}
                        value={row.productId}
                        onChange={(productId) => handleCatalogSelect(row, productId)}
                        placeholder="选择产品"
                        disabled={pending || !catalog}
                      />
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
                  {hasDailyFields && (
                    <div className="grid grid-cols-2 items-end gap-3 xl:grid-cols-[130px_130px_130px_120px]">
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
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {SHIPPING_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div key={row.key} className="space-y-3 rounded-md border-2 border-slate-300 p-3 shadow-sm dark:border-slate-700">
                  <div className="flex items-end gap-3">
                    <div className="w-[130px] shrink-0 space-y-1">
                      <Label>类型</Label>
                      <Select
                        value={row.sourceType}
                        onValueChange={(value) => switchSourceType(row.key, value as AppendRow['sourceType'])}
                        disabled={pending}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="catalog">普通产品</SelectItem>
                          <SelectItem value="custom">定制产品</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="min-w-0 flex-1 pb-2">
                      {row.linkedCustom ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          已关联：{[row.linkedCustom.code, row.linkedCustom.name].filter(Boolean).join(' · ')}
                          {row.linkedCustom.version_no > 0 ? `（v${row.linkedCustom.version_no}）` : '（本订单快照）'}
                          {customIdentityModified(row.linkedCustom, row.custom)
                            ? '，资料已修改，提交时将保存为新版本'
                            : ''}
                        </span>
                      ) : (
                        <span className="block truncate text-xs text-muted-foreground">
                          未选择已有定制产品，提交时将新建定制产品
                        </span>
                      )}
                    </div>
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

                  <div className="space-y-1">
                    <Label>选择定制产品（选填，选中后自动带入以下资料）</Label>
                    <BusinessCustomProductPicker
                      orderCurrency={currency}
                      productGroups={catalog?.productGroups ?? []}
                      value={row.linkedCustom && row.linkedCustom.version_no > 0 ? row.linkedCustom : null}
                      onChange={(product) => handleCustomProductSelect(row.key, product)}
                      onCreated={(product) => handleCustomProductSelect(row.key, product)}
                      allowCreate={false}
                      disabled={pending}
                    />
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="space-y-1">
                      <Label>产品分组</Label>
                      <Select
                        value={row.custom.groupId || undefined}
                        onValueChange={(value) => updateCustom(row.key, { groupId: value })}
                        disabled={pending}
                      >
                        <SelectTrigger><SelectValue placeholder="选择产品分组" /></SelectTrigger>
                        <SelectContent>
                          {(catalog?.productGroups ?? []).map((group) => (
                            <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label>币种</Label>
                      <Select
                        value={row.custom.currency}
                        onValueChange={(value) =>
                          updateCustom(row.key, { currency: value as CurrencyCode })
                        }
                        disabled={pending}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {CURRENCY_OPTIONS.map((item) => (
                            <SelectItem key={item} value={item}>{item}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label>编码</Label>
                      <Input
                        value={row.custom.code}
                        onChange={(event) => updateCustom(row.key, { code: event.target.value })}
                        maxLength={100}
                        placeholder="可留空"
                        disabled={pending}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>名称</Label>
                      <Input
                        value={row.custom.name}
                        onChange={(event) => updateCustom(row.key, { name: event.target.value })}
                        maxLength={300}
                        disabled={pending}
                      />
                    </div>
                    <div className="space-y-1 sm:col-span-2">
                      <Label>备注</Label>
                      <Textarea
                        value={row.custom.description}
                        onChange={(event) => updateCustom(row.key, { description: event.target.value })}
                        maxLength={4000}
                        disabled={pending}
                      />
                    </div>
                    <div className="space-y-1 sm:col-span-2">
                      <Label>规格</Label>
                      <Textarea
                        value={row.custom.specification}
                        onChange={(event) => updateCustom(row.key, { specification: event.target.value })}
                        maxLength={2000}
                        disabled={pending}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>单位</Label>
                      <Input
                        value={row.custom.unit}
                        onChange={(event) => updateCustom(row.key, { unit: event.target.value })}
                        maxLength={100}
                        placeholder="可留空"
                        disabled={pending}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>数量</Label>
                      <Input
                        type="number"
                        min="0.0001"
                        step="0.0001"
                        value={row.quantity}
                        onChange={(event) => updateQuantity(row.key, event.target.value)}
                        disabled={pending}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>销售单价（{currency}）</Label>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={row.unitPrice}
                        onChange={(event) => updateUnitPrice(row.key, event.target.value)}
                        disabled={pending}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>订单金额（{currency}）</Label>
                      <Input
                        type="number"
                        value={derivedOrderAmount(row.quantity, row.unitPrice)}
                        readOnly
                        tabIndex={-1}
                        className="bg-muted/40"
                      />
                      <p className="text-xs text-muted-foreground">数量 × 销售单价，自动计算</p>
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
                      <p className="text-xs text-muted-foreground">订单金额 − 实收金额；修改后会反算实收金额</p>
                    </div>
                    {hasDailyFields && (
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
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {SHIPPING_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="space-y-1 sm:col-span-2 xl:col-span-4">
                      <Label>产品图片</Label>
                      <div
                        className={`rounded-md border border-dashed p-4 transition-colors ${
                          draggingImageKey === row.key ? 'border-primary bg-primary/5' : 'border-input'
                        }`}
                        onDragEnter={(event) => {
                          event.preventDefault()
                          setDraggingImageKey(row.key)
                        }}
                        onDragOver={(event) => event.preventDefault()}
                        onDragLeave={() => setDraggingImageKey((current) => (current === row.key ? null : current))}
                        onDrop={(event) => handleImageDrop(row.key, event)}
                      >
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Input
                            type="file"
                            accept=".jpg,.jpeg,.png,image/jpeg,image/png"
                            onChange={(event) => handleImageFile(row.key, event)}
                            disabled={uploading || pending}
                            className="sm:max-w-xs"
                          />
                          <div className="relative flex-1">
                            <ImageIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                              aria-label="产品图片 URL"
                              type="url"
                              value={row.custom.imageUrl}
                              onChange={(event) => updateCustom(row.key, { imageUrl: event.target.value })}
                              maxLength={2000}
                              placeholder="或填写公开图片 URL"
                              className="pl-9"
                              disabled={pending}
                            />
                          </div>
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">支持拖放、选择 JPEG/PNG，单张不超过 20MB。</p>
                      </div>
                      {uploading && (
                        <p className="flex items-center gap-1 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />正在上传…
                        </p>
                      )}
                      {row.custom.imageUrl && (
                        <div className="relative h-36 w-36 overflow-hidden rounded-md border bg-muted">
                          <Image
                            src={toImageSrc(row.custom.imageUrl)}
                            alt="定制产品图片预览"
                            fill
                            className="object-cover"
                            sizes="144px"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  {row.custom.currency !== currency && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      定制产品币种为 {row.custom.currency}，与订单币种 {currency} 不一致；销售单价请按订单币种填写，系统不会自动换算。
                    </p>
                  )}
                </div>
              ),
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-slate-400 bg-slate-200 text-slate-900 hover:bg-slate-300"
                onClick={() => setRows((current) => [...current, emptyRow('catalog', currency)])}
                disabled={pending}
              >
                <Plus className="h-4 w-4" />
                添加一行
              </Button>
              {importableItems.length > 0 && (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="border-slate-400 bg-slate-200 text-slate-900 hover:bg-slate-300"
                      disabled={pending}
                    >
                      <ListPlus className="h-4 w-4" />
                      添加本订单产品
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-96 p-1" align="start">
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                      点击导入本订单已有产品（含单价与数量），导入后可修改。
                    </p>
                    <div className="max-h-72 overflow-y-auto">
                      {importableItems.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent"
                          onClick={() => importOrderItem(item)}
                        >
                          <ItemThumb src={item.image_url_snapshot} alt={businessOrderItemDisplayName(item)} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-sm font-medium">{businessOrderItemDisplayName(item)}</span>
                              {item.source_type === 'custom' && <Badge variant="outline">定制</Badge>}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {[businessOrderItemDisplaySku(item), item.specification_snapshot, item.unit_snapshot]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          </div>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {formatCurrency(Number(item.unit_price), currency)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>

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
              onClick={closeDialog}
              disabled={pending || uploading}
            >
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={pending || uploading}>
              {pending || uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              确认追加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
