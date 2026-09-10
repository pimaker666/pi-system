'use client'

import {
  ClipboardEvent,
  DragEvent,
  FormEvent,
  useMemo,
  useState,
  useTransition,
} from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Eye, LockKeyhole, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { CustomerCombobox } from '@/components/customers/customer-combobox'
import { BusinessCustomProductPicker } from '@/components/finance/business-custom-product-picker'
import type { DailyOrderShopOption } from '@/lib/daily-orders'
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
import {
  bindBusinessOrderAttachment,
  createBusinessOrder,
  getBusinessOrderAttachmentUrl,
  removeBusinessOrderAttachment,
  updateBusinessOrder,
} from '@/lib/actions/business-orders'
import { getBusinessDateKey } from '@/lib/business-orders'
import { createClient } from '@/lib/supabase/client'
import { cn, displayProfileName, formatCurrency, roundToScale } from '@/lib/utils'
import type {
  BusinessCustomProductListItem,
  BusinessFulfillmentType,
  BusinessOrderEditConstraints,
  BusinessOrderItemSourceType,
  BusinessOrderWithDetails,
  CurrencyCode,
  Customer,
  CustomerGroup,
  DailyOrderPaymentCategory,
  DailyOrderShippingCategory,
  Product,
  ProductGroup,
  Profile,
} from '@/types'

interface EditableItem {
  key: string
  order_item_id: string | null
  source_type: BusinessOrderItemSourceType
  product_id: string | null
  custom_product_id: string | null
  custom_product_version_id: string | null
  product_name: string
  sku: string
  description: string | null
  specification: string | null
  unit: string
  quantity: number | ''
  unit_price: number | ''
  daily_shipping_category: DailyOrderShippingCategory
  product_received_amount: number
  product_received_overridden: boolean
  logistics_fee_amount: number
  sales_total_amount: number
  sales_total_overridden: boolean
  default_currency: CurrencyCode | null
}

interface PendingAttachment {
  id: string
  file: File
}

interface BusinessOrderFormProps {
  profile: Pick<Profile, 'id' | 'role'>
  customers: Customer[]
  customerGroups: CustomerGroup[]
  productGroups: ProductGroup[]
  products: Product[]
  shops: DailyOrderShopOption[]
  salespeople: Pick<Profile, 'id' | 'full_name' | 'email' | 'chinese_name'>[]
  initialOrder?: BusinessOrderWithDetails
  editConstraints?: BusinessOrderEditConstraints
}

interface NormalizedItemConstraint {
  orderItemId: string
  hasActiveAllocation: boolean
  shippedQuantity: number
  returnedQuantity: number
  netShippedQuantity: number
  minimumQuantity: number
  canDelete: boolean
  identityLocked: boolean
  unitPriceLocked: boolean
  quantityLocked: boolean
}

const currencies: CurrencyCode[] = ['USD', 'EUR', 'CNY', 'GBP', 'JPY']
const SHIPPING_OPTIONS: Array<{ value: DailyOrderShippingCategory; label: string }> = [
  { value: 'stock', label: '现货' },
  { value: 'sample', label: '样品' },
  { value: 'custom', label: '定制' },
  { value: 'purchase', label: '外采' },
]

function randomHexNibble() {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buffer = new Uint8Array(1)
    crypto.getRandomValues(buffer)
    return buffer[0] % 16
  }
  return Math.floor(Math.random() * 16)
}

/**
 * 始终返回合法的 v4 UUID。
 * 生产通过 http 访问时属于非安全上下文，crypto.randomUUID 不可用，
 * 而该 id 会拼进截图对象路径并被 Storage RLS 的 UUID 正则校验，
 * 因此回退实现必须仍然产出 UUID 而非任意字符串。
 */
function newLocalId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const random = randomHexNibble()
    const value = token === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

function roundMoney(value: number) {
  return roundToScale(value, 2)
}

function derivedProductReceived(quantity: number, unitPrice: number) {
  return roundMoney(quantity * unitPrice)
}

function derivedSalesTotal(productReceived: number, logisticsFee: number) {
  return roundMoney(productReceived + logisticsFee)
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function numericValue(value: unknown) {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

function booleanValue(...values: unknown[]) {
  return values.some((value) => value === true)
}

function normalizeEditConstraints(value: unknown) {
  const root = recordValue(value)
  const rowsValue = Array.isArray(value)
    ? value
    : root && Array.isArray(root.items)
      ? root.items
      : root && Array.isArray(root.item_constraints)
        ? root.item_constraints
        : root && Array.isArray(root.rows)
          ? root.rows
          : []
  const hasActiveAllocation = booleanValue(
    root?.has_active_allocation,
    root?.has_active_allocations,
  )
  const constraints = new Map<string, NormalizedItemConstraint>()

  for (const candidate of rowsValue) {
    const row = recordValue(candidate)
    if (!row || typeof row.order_item_id !== 'string') continue
    const shippedQuantity = numericValue(
      row.gross_shipped_quantity ?? row.shipped_quantity ?? row.total_shipped_quantity,
    )
    const returnedQuantity = numericValue(row.returned_quantity ?? row.total_returned_quantity)
    const netShippedQuantity = Math.max(
      0,
      numericValue(row.net_shipped_quantity ?? shippedQuantity - returnedQuantity),
    )
    const minimumQuantity = Math.max(
      netShippedQuantity,
      numericValue(row.minimum_quantity ?? netShippedQuantity),
    )
    const rowHasAllocation = booleanValue(
      row.has_active_allocation,
      row.has_active_allocations,
      hasActiveAllocation,
    )
    const identityLocked = booleanValue(
      row.identity_locked,
      row.product_identity_locked,
      row.lock_identity,
      row.can_replace_product === false,
      rowHasAllocation,
      shippedQuantity > 0,
    )
    constraints.set(row.order_item_id, {
      orderItemId: row.order_item_id,
      hasActiveAllocation: rowHasAllocation,
      shippedQuantity,
      returnedQuantity,
      netShippedQuantity,
      minimumQuantity,
      canDelete:
        typeof row.can_delete === 'boolean'
          ? row.can_delete
          : !identityLocked,
      identityLocked,
      unitPriceLocked: booleanValue(
        row.unit_price_locked,
        row.lock_unit_price,
        row.can_change_unit_price === false,
        rowHasAllocation,
      ),
      quantityLocked: booleanValue(row.quantity_locked, row.lock_quantity),
    })
  }

  return {
    hasActiveAllocation:
      hasActiveAllocation || [...constraints.values()].some((row) => row.hasActiveAllocation),
    constraints,
  }
}

export function BusinessOrderForm({
  profile,
  customers,
  customerGroups,
  productGroups,
  products,
  shops,
  salespeople,
  initialOrder,
  editConstraints,
}: BusinessOrderFormProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [customer, setCustomer] = useState<Customer | null>(
    customers.find((item) => item.id === initialOrder?.customer_id) ?? null,
  )
  const [orderDate, setOrderDate] = useState(
    initialOrder?.order_date ?? getBusinessDateKey(),
  )
  const [shopId, setShopId] = useState(initialOrder?.shop_id ?? '')
  const [salespersonId, setSalespersonId] = useState(
    initialOrder?.salesperson_id ?? (['admin', 'finance'].includes(profile.role) ? '' : profile.id),
  )
  const [externalOrderNumber, setExternalOrderNumber] = useState(
    initialOrder?.external_order_number ?? '',
  )
  const [dailyShippingDate, setDailyShippingDate] = useState(
    initialOrder?.daily_shipping_date ?? initialOrder?.order_date ?? getBusinessDateKey(),
  )
  const [dailyShippingNumber, setDailyShippingNumber] = useState(
    initialOrder?.daily_shipping_number ?? '',
  )
  const [dailyPaymentCategory, setDailyPaymentCategory] = useState<DailyOrderPaymentCategory>(
    initialOrder?.daily_payment_category ?? 'full',
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
  const [selectedProductId, setSelectedProductId] = useState('')
  const [selectedCustomProduct, setSelectedCustomProduct] =
    useState<BusinessCustomProductListItem | null>(null)
  const [items, setItems] = useState<EditableItem[]>(
    initialOrder?.business_order_items
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((item) => ({
        key: item.id,
        order_item_id: item.id,
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
        daily_shipping_category: item.daily_shipping_category ?? 'stock',
        product_received_amount: Number(item.product_received_amount ?? item.line_amount),
        product_received_overridden: item.product_received_overridden,
        logistics_fee_amount: Number(item.logistics_fee_amount ?? 0),
        sales_total_amount: Number(item.sales_total_amount ?? item.line_amount),
        sales_total_overridden: item.sales_total_overridden,
        default_currency: null,
      })) ?? [],
  )
  const [totalProductOverride, setTotalProductOverride] = useState<number | null>(
    initialOrder?.total_product_received_overridden
      ? Number(initialOrder.total_product_received_amount ?? 0)
      : null,
  )
  const [totalShippingOverride, setTotalShippingOverride] = useState<number | null>(
    initialOrder?.total_shipping_received_overridden
      ? Number(initialOrder.total_shipping_received_amount ?? 0)
      : null,
  )
  const [receivableReceivedDifferenceReason, setReceivableReceivedDifferenceReason] = useState(
    initialOrder?.receivable_received_difference_reason ?? '',
  )
  const [files, setFiles] = useState<PendingAttachment[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [attachments, setAttachments] = useState(
    initialOrder?.business_order_attachments?.filter((item) => item.status === 'active') ?? [],
  )

  const subtotal = useMemo(
    () => items.reduce(
      (sum, item) =>
        sum + roundMoney(numericValue(item.quantity) * numericValue(item.unit_price)),
      0,
    ),
    [items],
  )
  const assignedSalespeople = useMemo(() => {
    const ids = new Set(shops.find((shop) => shop.id === shopId)?.salespersonIds ?? [])
    return salespeople.filter((person) => ids.has(person.id))
  }, [shopId, shops, salespeople])
  const automaticProductTotal = useMemo(
    () => roundMoney(items.reduce((sum, item) => sum + item.product_received_amount, 0)),
    [items],
  )
  const automaticShippingTotal = useMemo(
    () => roundMoney(items.reduce((sum, item) => sum + item.logistics_fee_amount, 0)),
    [items],
  )
  const automaticSalesTotal = useMemo(
    () => roundMoney(items.reduce((sum, item) => sum + item.sales_total_amount, 0)),
    [items],
  )
  const effectiveProductTotal = totalProductOverride ?? automaticProductTotal
  const effectiveShippingTotal = totalShippingOverride ?? automaticShippingTotal
  const effectiveSalesTotal = roundMoney(effectiveProductTotal + effectiveShippingTotal)
  const totalSalesOverridden =
    Math.round(effectiveSalesTotal * 100) !== Math.round(automaticSalesTotal * 100)
  const normalizedConstraints = useMemo(
    () => normalizeEditConstraints(editConstraints),
    [editConstraints],
  )
  const total = roundMoney(subtotal + (Number(shippingFee) || 0))
  const receivableReceivedDifference = roundMoney(total - effectiveSalesTotal)
  const hasReceivableReceivedDifference =
    Math.round(receivableReceivedDifference * 100) !== 0
  const orderWithClosure = initialOrder as
    | (BusinessOrderWithDetails & { closed_at?: string | null })
    | undefined
  const lifecycleLocked = Boolean(
    initialOrder?.status === 'completed' || orderWithClosure?.closed_at,
  )
  const hasLegacyItems = items.some((item) => item.source_type === 'legacy')
  const productRowsLocked = lifecycleLocked
  const productControlsDisabled = pending || productRowsLocked || hasLegacyItems

  function handleCustomerChange(nextCustomer: Customer | null) {
    setCustomer(nextCustomer)
  }

  function addProduct() {
    const product = products.find((item) => item.id === selectedProductId)
    if (!product) return
    if (items.some((item) => item.source_type === 'catalog' && item.product_id === product.id)) {
      toast.error('该产品已在订单中')
      return
    }
    setItems((current) => [
      ...current,
      {
        key: newLocalId(),
        order_item_id: null,
        source_type: 'catalog',
        product_id: product.id,
        custom_product_id: null,
        custom_product_version_id: null,
        product_name: product.name,
        sku: product.sku,
        description: product.description,
        specification: product.specification,
        unit: product.unit,
        quantity: '',
        unit_price: '',
        daily_shipping_category: 'stock',
        product_received_amount: 0,
        product_received_overridden: false,
        logistics_fee_amount: 0,
        sales_total_amount: 0,
        sales_total_overridden: false,
        default_currency: product.currency,
      },
    ])
    setSelectedProductId('')
  }

  function addCustomProduct(product: BusinessCustomProductListItem, keepSelected = false) {
    if (items.some((item) => item.custom_product_version_id === product.version_id)) {
      toast.error('该定制产品版本已在订单中')
      return
    }
    setItems((current) => [
      ...current,
      {
        key: newLocalId(),
        order_item_id: null,
        source_type: 'custom',
        product_id: null,
        custom_product_id: product.custom_product_id,
        custom_product_version_id: product.version_id,
        product_name: product.name,
        sku: product.code,
        description: product.description,
        specification: product.specification,
        unit: product.unit,
        quantity: '',
        unit_price: '',
        daily_shipping_category: 'custom',
        product_received_amount: 0,
        product_received_overridden: false,
        logistics_fee_amount: 0,
        sales_total_amount: 0,
        sales_total_overridden: false,
        default_currency: product.default_currency,
      },
    ])
    if (!keepSelected) setSelectedCustomProduct(null)
  }

  function changeShop(value: string) {
    setShopId(value)
    const shop = shops.find((item) => item.id === value)
    const assignedIds = shop?.salespersonIds ?? []
    if (!assignedIds.includes(salespersonId)) {
      setSalespersonId(
        ['admin', 'finance'].includes(profile.role)
          ? ''
          : assignedIds.includes(profile.id)
            ? profile.id
            : '',
      )
    }
    if (!initialOrder && shop) handleCurrencyChange(shop.default_currency)
  }

  function updateItem(key: string, field: 'quantity' | 'unit_price', value: string) {
    const number = value === '' ? '' : numericValue(value)
    setItems((current) =>
      current.map((item) => {
        if (item.key !== key) return item
        const next = { ...item, [field]: number }
        if (!next.product_received_overridden) {
          next.product_received_amount = derivedProductReceived(
            numericValue(next.quantity),
            numericValue(next.unit_price),
          )
        }
        if (!next.sales_total_overridden) {
          next.sales_total_amount = derivedSalesTotal(
            next.product_received_amount,
            next.logistics_fee_amount,
          )
        }
        return next
      }),
    )
  }

  function updateDailyItem(
    key: string,
    patch: Partial<
      Pick<
        EditableItem,
        | 'daily_shipping_category'
        | 'product_received_amount'
        | 'product_received_overridden'
        | 'logistics_fee_amount'
        | 'sales_total_amount'
        | 'sales_total_overridden'
      >
    >,
  ) {
    setItems((current) =>
      current.map((item) => {
        if (item.key !== key) return item
        const next = { ...item, ...patch }
        if (!next.sales_total_overridden) {
          next.sales_total_amount = derivedSalesTotal(
            next.product_received_amount,
            next.logistics_fee_amount,
          )
        }
        return next
      }),
    )
  }

  function handleCurrencyChange(value: CurrencyCode) {
    setCurrency(value)
    if (value === 'CNY') setExchangeRate('1')
    else if (currency === 'CNY') setExchangeRate('')

    const mismatchedItems = items.filter(
      (item) =>
        item.default_currency &&
        item.default_currency !== value &&
        numericValue(item.unit_price) !== 0,
    )
    if (mismatchedItems.length > 0) {
      setItems((current) =>
        current.map((item) => {
          if (!item.default_currency || item.default_currency === value) return item
          const productReceived = item.product_received_overridden ? item.product_received_amount : 0
          return {
            ...item,
            unit_price: '',
            product_received_amount: productReceived,
            sales_total_amount: item.sales_total_overridden
              ? item.sales_total_amount
              : derivedSalesTotal(productReceived, item.logistics_fee_amount),
          }
        }),
      )
      toast.info('币种已变更，来源币种不同的新增产品单价已清零，请重新填写')
    }
  }

  function addFiles(next: FileList | File[] | null) {
    const selected = Array.from(next ?? [])
    if (selected.length === 0) return
    if (attachments.length + files.length + selected.length > 10) {
      toast.error('每条订单最多 10 张截图')
      return
    }
    const invalid = selected.find(
      (file) => !['image/jpeg', 'image/png'].includes(file.type) || file.size > 20 * 1024 * 1024,
    )
    if (invalid) {
      toast.error(`${invalid.name} 不是 JPEG/PNG 或超过 20MB`)
      return
    }
    setFiles((current) => [
      ...current,
      ...selected.map((file) => ({ id: newLocalId(), file })),
    ])
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDragging(false)
    if (attachments.length < 10) addFiles(event.dataTransfer.files)
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    const images = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (images.length === 0) return
    event.preventDefault()
    addFiles(images)
  }

  async function uploadAttachments(orderId: string) {
    const supabase = createClient()
    const failures: string[] = []
    for (const pendingFile of files) {
      const { file } = pendingFile
      const extension = file.type === 'image/png' ? 'png' : file.name.toLowerCase().endsWith('.jpeg') ? 'jpeg' : 'jpg'
      const objectPath = `${profile.id}/${orderId}/${pendingFile.id}.${extension}`
      const { error: uploadError } = await supabase.storage
        .from('finance-daily-order-screenshots')
        .upload(objectPath, file, { contentType: file.type, upsert: false })
      if (uploadError) {
        failures.push(`${file.name}：${uploadError.message}`)
        continue
      }
      const result = await bindBusinessOrderAttachment({
        order_id: orderId,
        object_path: objectPath,
        original_name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
      })
      if (!result.ok) {
        await supabase.storage.from('finance-daily-order-screenshots').remove([objectPath])
        failures.push(`${file.name}：${result.error ?? '绑定失败'}`)
        continue
      }
      setFiles((current) => current.filter((item) => item.id !== pendingFile.id))
    }
    return failures
  }

  function viewAttachment(id: string) {
    startTransition(async () => {
      const result = await getBusinessOrderAttachmentUrl(id)
      if (result.url) window.open(result.url, '_blank', 'noopener,noreferrer')
      else toast.error(result.error ?? '无法查看截图')
    })
  }

  function removeAttachment(id: string) {
    if (!initialOrder || !window.confirm('确定移除这张截图吗？原文件将保留用于审计。')) return
    startTransition(async () => {
      const result = await removeBusinessOrderAttachment(id)
      if (!result.ok) {
        toast.error(result.error ?? '移除截图失败')
        return
      }
      setAttachments((current) => current.filter((item) => item.id !== id))
      toast.success('截图已移除')
    })
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (event.target !== event.currentTarget) return
    event.preventDefault()
    if (hasLegacyItems) {
      toast.error('订单含历史明细，V2 暂不支持写回，请联系管理员迁移或替换后再编辑')
      return
    }
    if (lifecycleLocked) {
      toast.error('已完成或特殊关闭的订单不可修改')
      return
    }
    const belowMinimum = items.find((item) => {
      const constraint = item.order_item_id
        ? normalizedConstraints.constraints.get(item.order_item_id)
        : undefined
      return constraint && numericValue(item.quantity) < constraint.minimumQuantity
    })
    if (belowMinimum) {
      const minimum = normalizedConstraints.constraints.get(
        belowMinimum.order_item_id as string,
      )?.minimumQuantity
      toast.error(`“${belowMinimum.product_name}”数量不能低于净已发数量 ${minimum}`)
      return
    }
    if (!customer && !['admin', 'finance'].includes(profile.role)) {
      toast.error('请选择客户')
      return
    }
    if (!shopId) {
      toast.error('请选择店铺')
      return
    }
    if (!salespersonId) {
      toast.error('请选择业务员')
      return
    }
    if (!externalOrderNumber.trim()) {
      toast.error('请输入订单号')
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
    const incompleteItem = items.find(
      (item) => item.quantity === '' || item.unit_price === '' || numericValue(item.quantity) <= 0,
    )
    if (incompleteItem) {
      toast.error(`请填写“${incompleteItem.product_name}”的有效数量和销售单价`)
      return
    }

    const input = {
      customer_id: customer?.id ?? null,
      shop_id: shopId,
      salesperson_id: salespersonId,
      external_order_number: externalOrderNumber,
      order_date: orderDate,
      payment_due_date: paymentDueDate,
      fulfillment_type: fulfillmentType,
      currency,
      exchange_rate_to_cny: exchangeRate,
      shipping_fee: shippingFee,
      tracking_number: trackingNumber,
      sales_notes: salesNotes,
      daily_shipping_date: dailyShippingDate,
      daily_shipping_number: dailyShippingNumber,
      daily_payment_category: dailyPaymentCategory,
      total_product_received_amount: effectiveProductTotal,
      total_product_received_overridden: totalProductOverride !== null,
      total_shipping_received_amount: effectiveShippingTotal,
      total_shipping_received_overridden: totalShippingOverride !== null,
      total_sales_amount: effectiveSalesTotal,
      total_sales_overridden: totalSalesOverridden,
      receivable_received_difference_reason: hasReceivableReceivedDifference
        ? receivableReceivedDifferenceReason
        : '',
      items: items.map((item) => {
        const dailyFields = {
          daily_shipping_category: item.daily_shipping_category,
          product_received_amount: item.product_received_amount,
          product_received_overridden: item.product_received_overridden,
          logistics_fee_amount: item.logistics_fee_amount,
          sales_total_amount: item.sales_total_amount,
          sales_total_overridden: item.sales_total_overridden,
        }
        if (item.source_type === 'catalog' && item.product_id) {
          return {
            ...(item.order_item_id ? { order_item_id: item.order_item_id } : {}),
            source_type: 'catalog' as const,
            product_id: item.product_id,
            quantity: numericValue(item.quantity),
            unit_price: numericValue(item.unit_price),
            ...dailyFields,
          }
        }
        if (
          item.source_type === 'custom' &&
          item.custom_product_id &&
          item.custom_product_version_id
        ) {
          return {
            ...(item.order_item_id ? { order_item_id: item.order_item_id } : {}),
            source_type: 'custom' as const,
            custom_product_id: item.custom_product_id,
            custom_product_version_id: item.custom_product_version_id,
            quantity: numericValue(item.quantity),
            unit_price: numericValue(item.unit_price),
            ...dailyFields,
          }
        }
        throw new Error('订单中存在无法写入的历史明细')
      }),
    }

    startTransition(async () => {
      const result = initialOrder
        ? await updateBusinessOrder(initialOrder.id, initialOrder.version, input)
        : await createBusinessOrder(input)

      if (!result.ok) {
        toast.error(result.error ?? '保存业务订单失败')
        return
      }

      const orderId = result.id ?? initialOrder?.id
      if (!orderId) {
        toast.error('数据库未返回订单 ID')
        return
      }
      const uploadFailures = files.length > 0 ? await uploadAttachments(orderId) : []
      if (uploadFailures.length > 0) {
        window.alert(`订单已保存，但以下截图上传失败，请在编辑页重新选择：\n${uploadFailures.join('\n')}`)
        window.location.assign(`/finance/daily-orders/${orderId}/edit`)
        return
      }

      toast.success(initialOrder ? '业务订单已更新' : '业务订单草稿已创建')
      router.push(`/finance/daily-orders/${orderId}`)
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

      {lifecycleLocked && (
        <div className="flex gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">订单已{orderWithClosure?.closed_at ? '特殊关闭' : '完成'}，全部字段只读</div>
            <div className="mt-1">页面仅展示锁定原因；数据库仍会拒绝任何绕过界面的修改。</div>
          </div>
        </div>
      )}

      <fieldset disabled={hasLegacyItems || lifecycleLocked} className="space-y-6 disabled:opacity-70">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">订单信息</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-2 xl:col-span-3">
              <Label>
                客户{!initialOrder && ['admin', 'finance'].includes(profile.role) ? '（可选）' : ''}
              </Label>
              <CustomerCombobox
                customers={customers}
                groups={customerGroups}
                value={customer}
                onChange={handleCustomerChange}
                allowClear={!initialOrder && ['admin', 'finance'].includes(profile.role)}
                allowCreate={
                  !hasLegacyItems &&
                  !lifecycleLocked &&
                  (profile.role === 'sales' ||
                    profile.role === 'supervisor' ||
                    profile.role === 'admin')
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="order_date">下单日期</Label>
              <Input
                id="order_date"
                type="date"
                value={orderDate}
                onChange={(event) => {
                  const value = event.target.value
                  if (dailyShippingDate === orderDate) setDailyShippingDate(value)
                  setOrderDate(value)
                }}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>店铺</Label>
              <Select value={shopId} onValueChange={changeShop}>
                <SelectTrigger><SelectValue placeholder="选择店铺" /></SelectTrigger>
                <SelectContent>
                  {shops
                    .filter((shop) => shop.is_active || shop.id === initialOrder?.shop_id)
                    .map((shop) => (
                      <SelectItem key={shop.id} value={shop.id}>
                        {shop.name}{shop.is_active ? '' : '（停用）'}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>业务员</Label>
              <Select value={salespersonId} onValueChange={setSalespersonId}>
                <SelectTrigger><SelectValue placeholder="选择业务员" /></SelectTrigger>
                <SelectContent>
                  {assignedSalespeople.map((person) => (
                    <SelectItem key={person.id} value={person.id}>{displayProfileName(person)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="external_order_number">订单号</Label>
              <Input
                id="external_order_number"
                value={externalOrderNumber}
                onChange={(event) => setExternalOrderNumber(event.target.value)}
                maxLength={200}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="daily_shipping_date">发货日期</Label>
              <Input
                id="daily_shipping_date"
                type="date"
                value={dailyShippingDate}
                onChange={(event) => setDailyShippingDate(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="daily_shipping_number">发货单号</Label>
              <Input
                id="daily_shipping_number"
                value={dailyShippingNumber}
                onChange={(event) => setDailyShippingNumber(event.target.value)}
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <Label>收款分类</Label>
              <Select
                value={dailyPaymentCategory}
                onValueChange={(value) => setDailyPaymentCategory(value as DailyOrderPaymentCategory)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">全款</SelectItem>
                  <SelectItem value="deposit">定金</SelectItem>
                  <SelectItem value="balance">尾款</SelectItem>
                </SelectContent>
              </Select>
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
              <Label htmlFor="shipping_fee">生命周期订单运费</Label>
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
              <Label htmlFor="tracking_number">生命周期货运单号</Label>
              <Input
                id="tracking_number"
                value={trackingNumber}
                onChange={(event) => setTrackingNumber(event.target.value)}
                maxLength={200}
              />
            </div>
            <div className="space-y-2 md:col-span-2 xl:col-span-3">
              <Label htmlFor="sales_notes">备注</Label>
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
                  <LockKeyhole className="h-3 w-3" />订单已锁定
                </Badge>
              )}
              {!productRowsLocked && normalizedConstraints.hasActiveAllocation && (
                <Badge variant="outline" className="gap-1 font-normal">
                  <LockKeyhole className="h-3 w-3" />已有有效分摊，产品身份及成交单价锁定
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
                  productGroups={productGroups}
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
              <Label>定制产品库</Label>
              <div className="flex flex-col gap-2 lg:flex-row">
                <BusinessCustomProductPicker
                  orderCurrency={currency}
                  productGroups={productGroups}
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
                可按产品分组筛选全局未归档版本；新建产品会立即加入当前订单。
              </p>
            </div>

            <div className="space-y-3">
              {items.map((item) => {
                const constraint = item.order_item_id
                  ? normalizedConstraints.constraints.get(item.order_item_id)
                  : undefined
                const identityLocked =
                  productRowsLocked || item.source_type === 'legacy' || Boolean(constraint?.identityLocked)
                const unitPriceLocked =
                  pending || productRowsLocked || item.source_type === 'legacy' || Boolean(constraint?.unitPriceLocked)
                const quantityLocked =
                  pending || productRowsLocked || item.source_type === 'legacy' || Boolean(constraint?.quantityLocked)
                const minimumQuantity = Math.max(constraint?.minimumQuantity ?? 0, 0.0001)
                const deleteLocked =
                  pending ||
                  identityLocked ||
                  (constraint ? !constraint.canDelete : false)
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
                              ? '定制产品'
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
                      {constraint && !productRowsLocked && (
                        <div className="mt-1 space-y-0.5 text-xs text-amber-700">
                          {constraint.hasActiveAllocation && (
                            <div>已有有效收款分摊：产品身份与成交单价不可修改。</div>
                          )}
                          {constraint.shippedQuantity > 0 && (
                            <div>
                              累计发货 {constraint.shippedQuantity.toLocaleString('zh-CN')}、累计退货{' '}
                              {constraint.returnedQuantity.toLocaleString('zh-CN')}，数量不得低于净已发{' '}
                              {constraint.netShippedQuantity.toLocaleString('zh-CN')}。
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="space-y-1">
                      <Label>数量</Label>
                      <Input
                        type="number"
                        min={minimumQuantity}
                        step="0.0001"
                        value={item.quantity}
                        onChange={(event) => updateItem(item.key, 'quantity', event.target.value)}
                        disabled={quantityLocked}
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>销售单价（{currency}）</Label>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={item.unit_price}
                        onChange={(event) => updateItem(item.key, 'unit_price', event.target.value)}
                        disabled={unitPriceLocked}
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>发货分类</Label>
                      <Select
                        value={item.daily_shipping_category}
                        onValueChange={(value) =>
                          updateDailyItem(item.key, {
                            daily_shipping_category: value as DailyOrderShippingCategory,
                          })
                        }
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {SHIPPING_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <Label>产品实收（{currency}）</Label>
                        {item.product_received_overridden && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-auto px-1 py-0 text-xs"
                            onClick={() => {
                              const value = derivedProductReceived(
                                numericValue(item.quantity),
                                numericValue(item.unit_price),
                              )
                              updateDailyItem(item.key, {
                                product_received_amount: value,
                                product_received_overridden: false,
                              })
                            }}
                          >恢复自动</Button>
                        )}
                      </div>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={item.product_received_amount}
                        onChange={(event) =>
                          updateDailyItem(item.key, {
                            product_received_amount: Number(event.target.value),
                            product_received_overridden: true,
                          })
                        }
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>运费实收（{currency}）</Label>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={item.logistics_fee_amount}
                        onChange={(event) =>
                          updateDailyItem(item.key, {
                            logistics_fee_amount: Number(event.target.value),
                          })
                        }
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <Label>明细实收合计（{currency}）</Label>
                        {item.sales_total_overridden && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-auto px-1 py-0 text-xs"
                            onClick={() =>
                              updateDailyItem(item.key, {
                                sales_total_amount: derivedSalesTotal(
                                  item.product_received_amount,
                                  item.logistics_fee_amount,
                                ),
                                sales_total_overridden: false,
                              })
                            }
                          >恢复自动</Button>
                        )}
                      </div>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={item.sales_total_amount}
                        onChange={(event) =>
                          updateDailyItem(item.key, {
                            sales_total_amount: Number(event.target.value),
                            sales_total_overridden: true,
                          })
                        }
                        required
                      />
                    </div>
                    <div className="text-right font-medium tabular-nums">
                      {formatCurrency(
                        numericValue(item.quantity) * numericValue(item.unit_price),
                        currency,
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))}
                      aria-label="移除产品"
                      disabled={deleteLocked}
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
              <div className="flex justify-between text-base font-semibold"><span>订单应收</span><span>{formatCurrency(total, currency)}</span></div>
            </div>
          </CardContent>
        </Card>
      </fieldset>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">订单金额汇总</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <Label>总产品实收（{currency}）</Label>
                {totalProductOverride !== null && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-auto px-1 py-0 text-xs"
                    onClick={() => setTotalProductOverride(null)}
                  >恢复自动计算</Button>
                )}
              </div>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={effectiveProductTotal}
                onChange={(event) => setTotalProductOverride(Number(event.target.value))}
                disabled={pending || lifecycleLocked}
                required
              />
              <p className="text-xs text-muted-foreground">
                自动汇总：{formatCurrency(automaticProductTotal, currency)}
              </p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <Label>总运费实收（{currency}）</Label>
                {totalShippingOverride !== null && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-auto px-1 py-0 text-xs"
                    onClick={() => setTotalShippingOverride(null)}
                  >恢复自动计算</Button>
                )}
              </div>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={effectiveShippingTotal}
                onChange={(event) => setTotalShippingOverride(Number(event.target.value))}
                disabled={pending || lifecycleLocked}
                required
              />
              <p className="text-xs text-muted-foreground">
                自动汇总：{formatCurrency(automaticShippingTotal, currency)}
              </p>
            </div>
            <div className="space-y-1">
              <Label>实际实收总额（{currency}）</Label>
              <Input type="number" value={effectiveSalesTotal} readOnly />
              <p className="text-xs text-muted-foreground">
                总产品实收 + 总运费实收；明细实收合计：{formatCurrency(
                  automaticSalesTotal,
                  currency,
                )}
              </p>
            </div>
          </div>
          <div className="rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted-foreground">应收 − 实收</span>
              <span className={cn('font-semibold tabular-nums', hasReceivableReceivedDifference && 'text-amber-700')}>
                {formatCurrency(receivableReceivedDifference, currency)}
              </span>
            </div>
            {hasReceivableReceivedDifference && (
              <div className="mt-3 space-y-2">
                <Label htmlFor="receivable_received_difference_reason">
                  差额原因（可选）
                </Label>
                <Textarea
                  id="receivable_received_difference_reason"
                  value={receivableReceivedDifferenceReason}
                  onChange={(event) => setReceivableReceivedDifferenceReason(event.target.value)}
                  maxLength={1000}
                  placeholder={receivableReceivedDifference > 0 ? '请说明少收原因' : '请说明多收原因'}
                  disabled={pending || lifecycleLocked}
                />
                <p className="text-xs text-muted-foreground">
                  正数表示少收，负数表示多收；原因会保存在订单中并写入审计记录。
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">订单截图</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className={cn(
              'rounded-md border border-dashed p-4 text-sm text-muted-foreground',
              isDragging && 'border-primary bg-primary/5',
            )}
            onDragOver={(event) => {
              event.preventDefault()
              setIsDragging(true)
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onPaste={handlePaste}
          >
            <div>拖拽、粘贴或选择 JPEG/PNG 截图，单张不超过 20MB，每单最多 10 张。</div>
            <Input
              type="file"
              accept="image/jpeg,image/png"
              multiple
              className="mt-2"
              onChange={(event) => {
                addFiles(event.target.files)
                event.target.value = ''
              }}
              disabled={pending || lifecycleLocked}
            />
            {!initialOrder && (
              <div className="mt-2 text-xs">截图将在订单创建成功后自动上传并绑定。</div>
            )}
          </div>

          {files.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-medium">待上传（{files.length}）</div>
              {files.map((pendingFile) => (
                <div
                  key={pendingFile.id}
                  className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                >
                  <span className="truncate">{pendingFile.file.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="移除待上传截图"
                    onClick={() =>
                      setFiles((current) => current.filter((item) => item.id !== pendingFile.id))
                    }
                    disabled={pending}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {attachments.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-medium">已绑定截图（{attachments.length}）</div>
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                >
                  <span className="truncate">{attachment.original_name ?? attachment.object_path}</span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="查看截图"
                      onClick={() => viewAttachment(attachment.id)}
                      disabled={pending}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="移除截图"
                      onClick={() => removeAttachment(attachment.id)}
                      disabled={pending || lifecycleLocked}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {files.length === 0 && attachments.length === 0 && (
            <div className="text-sm text-muted-foreground">暂无截图</div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button asChild type="button" variant="outline">
          <Link
            href={
              initialOrder
                ? `/finance/daily-orders/${initialOrder.id}`
                : '/finance/daily-orders'
            }
          >
            取消
          </Link>
        </Button>
        <Button type="submit" disabled={pending || hasLegacyItems || lifecycleLocked}>
          {pending ? '保存中…' : initialOrder ? '保存修改' : '创建草稿'}
        </Button>
      </div>
    </form>
  )
}
