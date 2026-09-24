'use client'

import Link from 'next/link'
import { useMemo, useState, useTransition } from 'react'
import { CheckCircle2, ListOrdered, Plus, Save, SlidersHorizontal, Tag, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DateRangePicker } from '@/components/shared/date-range-picker'
import { ImagePreview } from '@/components/ui/image-preview'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import {
  confirmBusinessOrderCommissionClearance,
  rejectBusinessOrderCommissionClearance,
  saveBusinessOrderCommission,
  saveBusinessOrderCommissionExchangeRate,
  saveBusinessOrderFreightCommissionRate,
  saveBusinessOrderItemCommission,
  saveCommissionCategoryRates,
  saveCustomerCommissionTags,
  saveCustomerCustomOrderCommissionRates,
  submitBusinessOrderCommissionClearance,
} from '@/lib/actions/commission'
import {
  BUSINESS_ORDER_COMMISSION_COLUMNS,
  COMMISSION_PAGE_SIZE,
  businessOrderCommissionFilterQuery,
} from '@/lib/business-order-commission'
import { formatDailyMoney, SHIPPING_LABELS } from '@/lib/daily-orders'
import { cn, displayProfileName } from '@/lib/utils'
import type { BusinessOrderCommissionFilters } from '@/schemas/business-order-commission'
import type {
  BusinessOrderCommissionClearanceStatus,
  BusinessOrderCommissionRow,
  CommissionCategoryRate,
  CustomerCommissionTag,
  CustomerCustomOrderCommissionRate,
  DailyOrderShippingCategory,
  DailyOrderShop,
  DailyOrderShopGroup,
  Profile,
} from '@/types'

const mergedCellClassName = 'bg-muted/20 align-top'

function commissionColumnClassName(label: string) {
  switch (label) {
    case '客户':
    case '产品实收金额':
    case '产品提点':
    case '产品提成':
    case '运费实收金额':
    case '运费成本':
    case '运费利润':
      return 'w-24 min-w-24'
    case '发货分类':
      return 'w-16 min-w-16'
    case '产品图片':
      return 'w-12 min-w-12'
    case '产品名称':
      return 'w-52 min-w-52'
    case '运费提成':
      return 'w-28 min-w-28'
    case '提成结清状态':
      return 'w-20 min-w-20'
    default:
      return ''
  }
}

function quantityText(value: number) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value)
}

function round4(value: number) {
  return Math.round(value * 10000) / 10000
}

function settlementExchangeRate(row: BusinessOrderCommissionRow, pageRate: number | null) {
  if (row.currency !== 'USD') return 1
  return pageRate ?? row.settlement_exchange_rate_to_cny
}

function formatCommissionMoney(
  value: number,
  row: BusinessOrderCommissionRow,
  pageRate: number | null,
) {
  const rate = settlementExchangeRate(row, pageRate)
  if (rate == null) return '请填写汇率'
  return formatDailyMoney(round4(value * rate), 'CNY')
}

function clearanceLabel(status: BusinessOrderCommissionClearanceStatus | null) {
  if (status === 'confirmed') return '已结清'
  if (status === 'pending') return '待确认'
  if (status === 'rejected') return '已驳回'
  return '未结清'
}

function clearanceVariant(status: BusinessOrderCommissionClearanceStatus | null) {
  if (status === 'confirmed') return 'success'
  if (status === 'pending') return 'default'
  if (status === 'rejected') return 'destructive'
  return 'secondary'
}

function hasCalculatedCommission(row: BusinessOrderCommissionRow) {
  return row.currency !== 'USD' || (row.settlement_exchange_rate_to_cny ?? 0) > 0
}

function isClearanceSelectable(row: BusinessOrderCommissionRow) {
  return row.commission_calculable && hasCalculatedCommission(row) && row.clearance_status !== 'confirmed'
}

function RateEditor({ row, readOnly }: { row: BusinessOrderCommissionRow; readOnly?: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const initialValue = row.product_commission_rate_overridden ? String(row.product_commission_rate) : ''
  const [draft, setDraft] = useState(initialValue)
  const normalized = draft.trim()
  const unchanged = normalized === initialValue

  function save() {
    const rate = normalized === '' ? null : Number(normalized)
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
      toast.error('提点必须是 0~100 的数字')
      return
    }
    startTransition(async () => {
      const result = await saveBusinessOrderItemCommission({
        business_order_item_ids: row.item_ids,
        rate,
      })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '产品提点保存失败')
        return
      }
      toast.success(rate === null ? '已恢复分类默认提点' : '产品提点已保存')
      router.refresh()
    })
  }

  const placeholder =
    row.product_commission_rate_source === 'customer_tag'
      ? `客户标记 ${row.product_commission_rate}`
      : row.product_commission_rate_source === 'custom_order_count'
        ? `定制单数 ${row.product_commission_rate}`
        : row.product_commission_rate_source === 'shipping_category'
          ? `分类默认 ${row.product_commission_rate}`
          : '未设置'

  if (!row.commission_calculable) {
    return <span className="text-sm text-muted-foreground">待补客户</span>
  }

  if (readOnly) {
    return (
      <div className="text-sm tabular-nums">
        {row.product_commission_rate}
        {row.product_commission_rate_overridden && (
          <span className="ml-1 text-xs text-muted-foreground">(覆盖)</span>
        )}
      </div>
    )
  }

  return (
    <div className="flex w-24 items-center gap-1">
      <Input
        value={draft}
        type="number"
        min={0}
        max={100}
        step="0.0001"
        disabled={pending}
        placeholder={placeholder}
        title="产品提点（百分数）；留空保存则恢复发货分类默认值"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !pending && !unchanged) {
            event.preventDefault()
            save()
          }
        }}
        className="h-7 w-16 px-1 text-xs"
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-7 w-7 shrink-0"
        disabled={pending || unchanged}
        onClick={save}
        aria-label={`保存订单 ${row.order_number} 的产品提点`}
        title="保存；留空则恢复分类默认提点"
      >
        <Save className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

function FreightEditor({
  row,
  rowSpan,
  readOnly,
  exchangeRate,
  defaultFreightCommissionRate,
}: {
  row: BusinessOrderCommissionRow
  rowSpan: number
  readOnly?: boolean
  exchangeRate: number | null
  defaultFreightCommissionRate: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const initialCost = row.freight_cost === 0 ? '' : String(row.freight_cost)
  const [costDraft, setCostDraft] = useState(initialCost)
  const unchanged = costDraft.trim() === initialCost

  const cost = costDraft.trim() === '' ? 0 : Number(costDraft)
  const freightRate = cost > 0 ? defaultFreightCommissionRate : 0
  const rateToCny = settlementExchangeRate(row, exchangeRate)
  const freightReceived = rateToCny == null ? null : round4(row.freight_received_amount * rateToCny)
  const profit = freightReceived == null ? null : round4(freightReceived - cost)
  const commission = profit == null ? null : round4((profit * freightRate) / 100)

  function save() {
    if (!Number.isFinite(cost) || cost < 0) {
      toast.error('运费成本必须是非负数字')
      return
    }
    if (row.currency === 'USD' && rateToCny == null) {
      toast.error('请先填写美元兑人民币汇率')
      return
    }
    startTransition(async () => {
      const result = await saveBusinessOrderCommission({
        business_order_id: row.order_id,
        freight_cost: cost,
        settlement_exchange_rate_to_cny: row.currency === 'USD' ? rateToCny : null,
      })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '运费提成保存失败')
        return
      }
      toast.success('运费成本与提点已保存')
      router.refresh()
    })
  }

  if (readOnly) {
    return (
      <>
        <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} tabular-nums`}>
          {freightReceived == null ? '请填写汇率' : formatDailyMoney(freightReceived, 'CNY')}
        </TableCell>
        <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} w-20 min-w-20 tabular-nums`}>
          {formatDailyMoney(row.freight_cost, 'CNY')}
        </TableCell>
        <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} tabular-nums`}>
          {profit == null ? '请填写汇率' : formatDailyMoney(profit, 'CNY')}
        </TableCell>
        <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} bg-amber-50 font-semibold text-amber-950 tabular-nums`}>
          {commission == null ? '请填写汇率' : formatDailyMoney(commission, 'CNY')}
        </TableCell>
      </>
    )
  }

  return (
    <>
      <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} tabular-nums`}>
        {freightReceived == null ? '请填写汇率' : formatDailyMoney(freightReceived, 'CNY')}
      </TableCell>
      <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} w-20 min-w-20`}>
        <div className="w-20">
          <Input
            value={costDraft}
            type="number"
            min={0}
            step="0.0001"
            disabled={pending}
            placeholder="未填写"
            title="运费成本（人民币）；留空按 0 计算"
            onChange={(event) => setCostDraft(event.target.value)}
            className="h-7 w-20 px-1 text-xs"
          />
        </div>
      </TableCell>
      <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} tabular-nums`}>
        {profit == null ? '请填写汇率' : formatDailyMoney(profit, 'CNY')}
      </TableCell>
      <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} bg-amber-50 font-semibold text-amber-950 tabular-nums`}>
        <div className="flex min-w-28 items-center gap-1">
          {commission == null ? '请填写汇率' : formatDailyMoney(commission, 'CNY')}
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-7 w-7 shrink-0"
            disabled={pending || unchanged}
            onClick={save}
            aria-label={`保存订单 ${row.order_number} 的运费成本`}
            title="保存运费成本；正数成本自动套用默认运费提点"
          >
            <Save className="h-3.5 w-3.5" />
          </Button>
        </div>
      </TableCell>
    </>
  )
}

interface Option {
  id: string
  name: string
}

function MultiSelect({
  name,
  label,
  options,
  selected,
}: {
  name: string
  label: string
  options: Option[]
  selected: string[]
}) {
  const selectedSet = new Set(selected)
  const count = options.filter((o) => selectedSet.has(o.id)).length
  return (
    <details className="group relative">
      <summary className="flex h-10 cursor-pointer items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm [&::-webkit-details-marker]:hidden">
        <span className="truncate">{count ? `${label} (${count})` : `全部${label}`}</span>
        <span aria-hidden className="text-xs text-muted-foreground">▼</span>
      </summary>
      <div className="absolute z-50 mt-1 max-h-64 w-56 overflow-auto rounded-md border bg-background p-2 shadow-md">
        {options.map((option) => (
          <label
            key={option.id}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
          >
            <input
              type="checkbox"
              name={name}
              value={option.id}
              defaultChecked={selectedSet.has(option.id)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <span className="truncate">{option.name}</span>
          </label>
        ))}
      </div>
    </details>
  )
}

const OPTIONAL_COMMISSION_COLUMNS = [
  ['order_number', '订单号'],
  ['order_date', '订单日期'],
  ['shipping_date', '发货日期'],
  ['shop', '店铺'],
  ['shop_group', '店铺分组'],
  ['salesperson', '业务员'],
  ['custom_order_count', '定制订单数'],
  ['quantity', '数量'],
  ['unit_price', '单价'],
] as const

type OptionalCommissionColumn = (typeof OPTIONAL_COMMISSION_COLUMNS)[number][0]

function optionalCommissionColumnClassName(column: OptionalCommissionColumn) {
  switch (column) {
    case 'order_number':
      return 'w-28 min-w-28'
    case 'order_date':
    case 'shipping_date':
    case 'shop':
    case 'shop_group':
    case 'salesperson':
      return 'w-24 min-w-24'
    case 'custom_order_count':
    case 'quantity':
      return 'w-16 min-w-16'
    case 'unit_price':
      return 'w-20 min-w-20'
  }
}

function DisplayColumnSelector({
  visibleColumns,
  onToggle,
}: {
  visibleColumns: Set<OptionalCommissionColumn>
  onToggle: (column: OptionalCommissionColumn, checked: boolean) => void
}) {
  return (
    <details className="group relative">
      <summary className="flex h-10 cursor-pointer items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm [&::-webkit-details-marker]:hidden">
        <span>显示列{visibleColumns.size ? ` (${visibleColumns.size})` : ''}</span>
        <span aria-hidden className="text-xs text-muted-foreground">▼</span>
      </summary>
      <div className="absolute right-0 z-50 mt-1 w-48 rounded-md border bg-background p-2 shadow-md">
        {OPTIONAL_COMMISSION_COLUMNS.map(([column, label]) => (
          <label key={column} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
            <input
              type="checkbox"
              checked={visibleColumns.has(column)}
              onChange={(event) => onToggle(column, event.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            {label}
          </label>
        ))}
      </div>
    </details>
  )
}

const CATEGORY_ORDER: DailyOrderShippingCategory[] = ['stock', 'sample', 'custom', 'purchase']

function CategoryRatesDialog({
  categoryRates,
}: {
  categoryRates: CommissionCategoryRate[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const initial = useMemo(() => {
    const map = new Map(categoryRates.map((row) => [row.category, row.product_commission_rate]))
    return CATEGORY_ORDER.reduce<Record<string, string>>((acc, category) => {
      const value = map.get(category)
      acc[category] = value == null ? '' : String(value)
      return acc
    }, {})
  }, [categoryRates])
  const [drafts, setDrafts] = useState<Record<string, string>>(initial)

  function save() {
    const rates = CATEGORY_ORDER.map((category) => {
      const raw = drafts[category]?.trim()
      return { category, product_commission_rate: raw === '' || raw == null ? 0 : Number(raw) }
    })
    if (rates.some((row) => !Number.isFinite(row.product_commission_rate) || row.product_commission_rate < 0 || row.product_commission_rate > 100)) {
      toast.error('提点必须是 0~100 的数字')
      return
    }
    startTransition(async () => {
      const result = await saveCommissionCategoryRates({ rates })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '分类提点保存失败')
        return
      }
      toast.success('发货分类提点已保存，产品行未单独设置的将按此默认')
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <SlidersHorizontal className="mr-1.5 h-4 w-4" />
        按发货分类设置提点
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>按发货分类设置产品提点</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              设置后，对应发货分类的产品行会自动套用该提点；单独修改过某行提点的仍以行内为准。
            </p>
            {CATEGORY_ORDER.map((category) => (
              <div key={category} className="flex items-center gap-3">
                <label className="w-16 text-sm font-medium" htmlFor={`rate-${category}`}>
                  {SHIPPING_LABELS[category]}
                </label>
                <div className="relative flex-1">
                  <Input
                    id={`rate-${category}`}
                    type="number"
                    min={0}
                    max={100}
                    step="0.0001"
                    value={drafts[category] ?? ''}
                    placeholder="0"
                    onChange={(event) =>
                      setDrafts((prev) => ({ ...prev, [category]: event.target.value }))
                    }
                    className="pr-7"
                  />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                    %
                  </span>
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="button" disabled={pending} onClick={save}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface TagDraft {
  key: string
  tag_color: string
  label: string
  rate: string
}

let tagKeySeq = 0
function nextTagKey() {
  tagKeySeq += 1
  return `tag-${tagKeySeq}`
}

function CustomerTagsDialog({ customerTags }: { customerTags: CustomerCommissionTag[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const initial = useMemo<TagDraft[]>(
    () =>
      customerTags.map((tag) => ({
        key: nextTagKey(),
        tag_color: tag.tag_color,
        label: tag.label,
        rate: String(tag.product_commission_rate),
      })),
    [customerTags],
  )
  const [drafts, setDrafts] = useState<TagDraft[]>(initial)

  function reset() {
    setDrafts(
      customerTags.map((tag) => ({
        key: nextTagKey(),
        tag_color: tag.tag_color,
        label: tag.label,
        rate: String(tag.product_commission_rate),
      })),
    )
  }

  function update(key: string, patch: Partial<TagDraft>) {
    setDrafts((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  function addRow() {
    setDrafts((prev) => [...prev, { key: nextTagKey(), tag_color: '#3b82f6', label: '', rate: '' }])
  }

  function removeRow(key: string) {
    setDrafts((prev) => prev.filter((row) => row.key !== key))
  }

  function save() {
    const seen = new Set<string>()
    const tags: Array<{ tag_color: string; label: string; product_commission_rate: number; sort_order: number }> = []
    for (let index = 0; index < drafts.length; index += 1) {
      const row = drafts[index]
      const color = row.tag_color.trim()
      if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
        toast.error('颜色格式错误（应为 #RRGGBB）')
        return
      }
      const key = color.toLowerCase()
      if (seen.has(key)) {
        toast.error('同一颜色只能有一个标记')
        return
      }
      seen.add(key)
      const label = row.label.trim()
      if (!label) {
        toast.error('请填写每个标记的含义')
        return
      }
      const rate = row.rate.trim() === '' ? 0 : Number(row.rate)
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        toast.error('提点必须是 0~100 的数字')
        return
      }
      tags.push({ tag_color: color, label, product_commission_rate: rate, sort_order: index })
    }
    startTransition(async () => {
      const result = await saveCustomerCommissionTags({ tags })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '客户标记保存失败')
        return
      }
      toast.success('客户标记已保存，选用该标记的客户将按此提点计算')
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          reset()
          setOpen(true)
        }}
      >
        <Tag className="mr-1.5 h-4 w-4" />
        按客户标记设置提成
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>按客户标记设置产品提点</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              维护一套客户标记（颜色 + 含义 + 产品提点）。客户库中选用某标记颜色的客户，其订单产品提点优先按标记计算；
              未打标记的客户回退到发货分类默认值。产品行单独改过提点的仍以行内为准。
            </p>
            <div className="space-y-2">
              {drafts.map((row) => (
                <div key={row.key} className="flex items-center gap-2">
                  <input
                    type="color"
                    value={row.tag_color || '#3b82f6'}
                    onChange={(event) => update(row.key, { tag_color: event.target.value })}
                    className="h-9 w-9 shrink-0 cursor-pointer rounded-md border-0 p-0"
                    aria-label="标记颜色"
                  />
                  <Input
                    value={row.label}
                    placeholder="标记含义，如 VIP 客户"
                    onChange={(event) => update(row.key, { label: event.target.value })}
                    className="h-9 flex-1"
                  />
                  <div className="relative w-28 shrink-0">
                    <Input
                      value={row.rate}
                      type="number"
                      min={0}
                      max={100}
                      step="0.0001"
                      placeholder="0"
                      title="产品提点（百分数）"
                      onChange={(event) => update(row.key, { rate: event.target.value })}
                      className="h-9 pr-7"
                    />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      %
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0 text-destructive"
                    onClick={() => removeRow(row.key)}
                    aria-label="删除该标记"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {drafts.length === 0 && (
                <p className="py-2 text-center text-sm text-muted-foreground">
                  暂无标记，点击下方按钮添加
                </p>
              )}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addRow}>
              <Plus className="mr-1.5 h-4 w-4" />
              添加标记
            </Button>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="button" disabled={pending} onClick={save}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface CustomOrderRateDraft {
  key: string
  maximum: string
  rate: string
}

function CustomOrderCountRatesDialog({
  rates,
}: {
  rates: CustomerCustomOrderCommissionRate[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [drafts, setDrafts] = useState<CustomOrderRateDraft[]>([])

  function reset() {
    setDrafts(
      rates.map((rate) => ({
        key: nextTagKey(),
        maximum: String(rate.maximum_custom_order_count),
        rate: String(rate.product_commission_rate),
      })),
    )
  }

  function update(key: string, patch: Partial<CustomOrderRateDraft>) {
    setDrafts((previous) => previous.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  function save() {
    const seen = new Set<number>()
    const nextRates: Array<{ maximum_custom_order_count: number; product_commission_rate: number }> = []
    for (const row of drafts) {
      const maximum = Number(row.maximum.trim())
      const rate = Number(row.rate.trim())
      if (!Number.isInteger(maximum) || maximum < 0) {
        toast.error('定制单数必须是非负整数')
        return
      }
      if (seen.has(maximum)) {
        toast.error('同一定制单数只能设置一条规则')
        return
      }
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        toast.error('提点必须是 0~100 的数字')
        return
      }
      seen.add(maximum)
      nextRates.push({ maximum_custom_order_count: maximum, product_commission_rate: rate })
    }
    startTransition(async () => {
      const result = await saveCustomerCustomOrderCommissionRates({ rates: nextRates })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '定制单数提点保存失败')
        return
      }
      toast.success('定制单数提点已保存')
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          reset()
          setOpen(true)
        }}
      >
        <ListOrdered className="mr-1.5 h-4 w-4" />
        按定制单数设置提点
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>按定制单数设置产品提点</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              客户累计定制订单数不超过规则单数时，按满足条件的最低上限套用。优先级低于客户标记，高于发货分类默认；产品行单独设置仍优先。
            </p>
            <div className="space-y-2">
              {drafts.map((row) => (
                <div key={row.key} className="flex items-center gap-2">
                  <Input
                    value={row.maximum}
                    type="number"
                    min={0}
                    step={1}
                    placeholder="定制单数"
                    aria-label="最高定制单数"
                    onChange={(event) => update(row.key, { maximum: event.target.value })}
                    className="h-9 flex-1"
                  />
                  <span className="text-sm text-muted-foreground">单及以下</span>
                  <div className="relative w-28 shrink-0">
                    <Input
                      value={row.rate}
                      type="number"
                      min={0}
                      max={100}
                      step="0.0001"
                      placeholder="0"
                      aria-label="产品提点"
                      onChange={(event) => update(row.key, { rate: event.target.value })}
                      className="h-9 pr-7"
                    />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0 text-destructive"
                    onClick={() => setDrafts((previous) => previous.filter((draft) => draft.key !== row.key))}
                    aria-label="删除该规则"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {drafts.length === 0 && (
                <p className="py-2 text-center text-sm text-muted-foreground">暂无规则，点击下方按钮添加</p>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDrafts((previous) => [...previous, { key: nextTagKey(), maximum: '', rate: '' }])}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              添加规则
            </Button>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button type="button" disabled={pending} onClick={save}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function FreightCommissionRateDialog({
  orderIds,
  defaultRate,
}: {
  orderIds: string[]
  defaultRate: number
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(String(defaultRate))
  const [pending, startTransition] = useTransition()

  function save() {
    const rate = Number(draft.trim())
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      toast.error('运费提点必须是 0~100 的数字')
      return
    }
    startTransition(async () => {
      const result = await saveBusinessOrderFreightCommissionRate({
        business_order_ids: orderIds,
        freight_commission_rate: rate,
      })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '运费提点保存失败')
        return
      }
      toast.success(`已将运费提点应用到当前页 ${orderIds.length} 个订单`)
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={orderIds.length === 0}
        onClick={() => {
          setDraft(String(defaultRate))
          setOpen(true)
        }}
      >
        <SlidersHorizontal className="mr-1.5 h-4 w-4" />
        设置运费提点
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>设置运费提点</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              保存默认运费提点后，当前页正数运费成本订单立即套用；未填写或为 0 的运费成本固定按 0% 计算，后续填写正数成本时自动套用。
            </p>
            <div className="relative">
              <Input
                value={draft}
                type="number"
                min={0}
                max={100}
                step="0.0001"
                aria-label="运费提点"
                onChange={(event) => setDraft(event.target.value)}
                className="pr-8"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button type="button" disabled={pending} onClick={save}>保存并应用当前页</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function CustomerTagsLegend({ customerTags }: { customerTags: CustomerCommissionTag[] }) {
  if (customerTags.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <span className="text-muted-foreground">客户标记：</span>
      {customerTags.map((tag) => (
        <span key={tag.tag_color} className="flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-3 shrink-0 rounded-full border"
            style={{ backgroundColor: tag.tag_color }}
          />
          <span>{tag.label}</span>
          <span className="tabular-nums text-muted-foreground">{tag.product_commission_rate}%</span>
        </span>
      ))}
    </div>
  )
}

export interface CommissionManagerProps {
  rows: BusinessOrderCommissionRow[]
  totalCount: number
  filters: BusinessOrderCommissionFilters
  categoryRates: CommissionCategoryRate[]
  customerTags: CustomerCommissionTag[]
  customOrderRates: CustomerCustomOrderCommissionRate[]
  defaultFreightCommissionRate: number
  canManageCategoryRates: boolean
  isAdmin: boolean
  actor: Profile
  readOnly?: boolean
  options: {
    shops: DailyOrderShop[]
    groups: DailyOrderShopGroup[]
    salespeople: Pick<Profile, 'id' | 'full_name' | 'email' | 'chinese_name'>[]
  }
}

export function CommissionManager({
  rows,
  totalCount,
  filters,
  categoryRates,
  customerTags,
  customOrderRates,
  defaultFreightCommissionRate,
  canManageCategoryRates,
  isAdmin,
  actor,
  readOnly = false,
  options,
}: CommissionManagerProps) {
  const router = useRouter()
  const currentPage = filters.page
  const totalPages = Math.max(1, Math.ceil(totalCount / COMMISSION_PAGE_SIZE))
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [selectedConfirmationItemIds, setSelectedConfirmationItemIds] = useState<Set<string>>(new Set())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7))
  const [submitPending, startSubmitTransition] = useTransition()
  const [confirmPending, startConfirmTransition] = useTransition()
  const [rejectPending, startRejectTransition] = useTransition()
  const [rejectingRow, setRejectingRow] = useState<BusinessOrderCommissionRow | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [exchangeRate, setExchangeRate] = useState('')
  const [exchangeRatePending, startExchangeRateTransition] = useTransition()
  const [visibleColumns, setVisibleColumns] = useState<Set<OptionalCommissionColumn>>(new Set())

  const isSalespersonView = actor.role === 'sales' || actor.role === 'supervisor'
  const currentExchangeRate = useMemo(() => {
    const value = Number(exchangeRate)
    return Number.isFinite(value) && value > 0 ? value : null
  }, [exchangeRate])
  const usdOrderIds = useMemo(
    () => [
      ...new Set(
        rows
          .filter((row) => row.currency === 'USD' && row.commission_calculable)
          .map((row) => row.order_id),
      ),
    ],
    [rows],
  )
  const lockedUsdOrderIds = useMemo(
    () => new Set(
      rows
        .filter((row) => row.currency === 'USD' && ['pending', 'confirmed'].includes(row.clearance_status ?? ''))
        .map((row) => row.order_id),
    ),
    [rows],
  )
  const editableUsdOrderIds = useMemo(
    () => usdOrderIds.filter((orderId) => !lockedUsdOrderIds.has(orderId)),
    [lockedUsdOrderIds, usdOrderIds],
  )
  const freightCommissionOrderIds = useMemo(
    () => [...new Set(rows.filter((row) => row.commission_calculable).map((row) => row.order_id))],
    [rows],
  )
  const canConfirmClearance = isSalespersonView

  const groups = useMemo(() => {
    const map = new Map<string, BusinessOrderCommissionRow[]>()
    for (const row of rows) {
      const list = map.get(row.order_id) ?? []
      list.push(row)
      map.set(row.order_id, list)
    }
    return [...map.values()]
  }, [rows])

  const selectableRows = useMemo(() => rows.filter(isClearanceSelectable), [rows])
  const selectedCount = useMemo(
    () => rows.filter((row) => row.item_ids.every((id) => selectedItemIds.has(id))).length,
    [rows, selectedItemIds],
  )
  const allSelected =
    selectableRows.length > 0 &&
    selectableRows.every((row) => row.item_ids.every((id) => selectedItemIds.has(id)))
  const confirmationSelectableRows = useMemo(
    () => rows.filter((row) => row.clearance_status === 'pending'),
    [rows],
  )
  const selectedConfirmationCount = useMemo(
    () => confirmationSelectableRows.filter((row) => row.item_ids.every((id) => selectedConfirmationItemIds.has(id))).length,
    [confirmationSelectableRows, selectedConfirmationItemIds],
  )
  const allConfirmationSelected =
    confirmationSelectableRows.length > 0 &&
    confirmationSelectableRows.every((row) => row.item_ids.every((id) => selectedConfirmationItemIds.has(id)))

  function toggleRow(row: BusinessOrderCommissionRow, checked: boolean) {
    setSelectedItemIds((previous) => {
      const next = new Set(previous)
      for (const id of row.item_ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  function toggleSelectAll(checked: boolean) {
    setSelectedItemIds(() => {
      if (!checked) return new Set()
      const next = new Set<string>()
      for (const row of selectableRows) {
        for (const id of row.item_ids) next.add(id)
      }
      return next
    })
  }

  function toggleConfirmationRow(row: BusinessOrderCommissionRow, checked: boolean) {
    setSelectedConfirmationItemIds((previous) => {
      const next = new Set(previous)
      for (const id of row.item_ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  function toggleSelectAllConfirmation(checked: boolean) {
    setSelectedConfirmationItemIds(() => {
      if (!checked) return new Set()
      const next = new Set<string>()
      for (const row of confirmationSelectableRows) {
        for (const id of row.item_ids) next.add(id)
      }
      return next
    })
  }

  function confirmSubmitClearance() {
    const itemIds = [...selectedItemIds]
    if (itemIds.length === 0) {
      toast.error('请先勾选产品行')
      return
    }
    startSubmitTransition(async () => {
      const result = await submitBusinessOrderCommissionClearance({
        business_order_item_ids: itemIds,
        period,
      })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '提交结清失败')
        return
      }
      toast.success(`已提交 ${selectedCount} 个产品行结清至 ${period}`)
      setSelectedItemIds(new Set())
      setDialogOpen(false)
      router.refresh()
    })
  }

  function confirmRowClearance(row: BusinessOrderCommissionRow) {
    startConfirmTransition(async () => {
      const result = await confirmBusinessOrderCommissionClearance({
        business_order_item_ids: row.item_ids,
      })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '确认结清失败')
        return
      }
      toast.success('已确认提成结清')
      router.refresh()
    })
  }

  function confirmSelectedClearances() {
    const itemIds = [...selectedConfirmationItemIds]
    if (itemIds.length === 0) {
      toast.error('请先勾选待确认产品行')
      return
    }
    startConfirmTransition(async () => {
      const result = await confirmBusinessOrderCommissionClearance({ business_order_item_ids: itemIds })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '批量确认结清失败')
        return
      }
      toast.success(`已确认 ${selectedConfirmationCount} 个产品行结清`)
      setSelectedConfirmationItemIds(new Set())
      router.refresh()
    })
  }

  function submitRowRejection() {
    if (!rejectingRow) return
    const reason = rejectReason.trim()
    if (!reason) {
      toast.error('请填写驳回原因')
      return
    }
    startRejectTransition(async () => {
      const result = await rejectBusinessOrderCommissionClearance({
        business_order_item_ids: rejectingRow.item_ids,
        reason,
      })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '驳回结清失败')
        return
      }
      toast.success('已驳回提成结清')
      setRejectingRow(null)
      setRejectReason('')
      router.refresh()
    })
  }

  function saveExchangeRate() {
    if (currentExchangeRate == null) {
      toast.error('请填写大于 0 的美元兑人民币汇率')
      return
    }
    if (editableUsdOrderIds.length === 0) {
      toast.error('当前页没有可修改汇率的美元订单')
      return
    }
    startExchangeRateTransition(async () => {
      const result = await saveBusinessOrderCommissionExchangeRate({
        business_order_ids: editableUsdOrderIds,
        settlement_exchange_rate_to_cny: currentExchangeRate,
      })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '汇率保存失败')
        return
      }
      toast.success(`已将汇率应用到当前页 ${editableUsdOrderIds.length} 个美元订单`)
      router.refresh()
    })
  }

  function toggleVisibleColumn(column: OptionalCommissionColumn, checked: boolean) {
    setVisibleColumns((previous) => {
      const next = new Set(previous)
      if (checked) next.add(column)
      else next.delete(column)
      return next
    })
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          已收齐且已发货的产品行自动进入本页；未关联客户的订单仅供补充客户信息，不能计算或结清提成。
          产品提成 = 产品实收金额 × 产品提点%；运费利润 = 运费实收 − 运费成本；运费提成 = 运费利润 × 运费提点%。
          产品提点优先级：手动逐行 &gt; 客户标记 &gt; 定制单数（仅定制发货分类）&gt; 发货分类默认。
        </p>
        <div className="flex flex-wrap gap-2">
          {!readOnly && isAdmin && <CustomerTagsDialog customerTags={customerTags} />}
          {!readOnly && canManageCategoryRates && <CustomOrderCountRatesDialog rates={customOrderRates} />}
          {!readOnly && canManageCategoryRates && <CategoryRatesDialog categoryRates={categoryRates} />}
          {!readOnly && canManageCategoryRates && (
            <FreightCommissionRateDialog
              orderIds={freightCommissionOrderIds}
              defaultRate={defaultFreightCommissionRate}
            />
          )}
        </div>
      </div>

      {!readOnly && <div className="flex flex-wrap items-center gap-3 rounded-md border bg-card p-4">
        <label htmlFor="commission-exchange-rate" className="text-sm font-medium">
          USD→CNY 汇率
        </label>
        <Input
          id="commission-exchange-rate"
          type="number"
          min="0"
          step="0.000001"
          placeholder="填写后美元金额自动换算为人民币"
          value={exchangeRate}
          onChange={(event) => setExchangeRate(event.target.value)}
          disabled={isSalespersonView || editableUsdOrderIds.length === 0}
          className="w-[260px]"
        />
        {!isSalespersonView && (
          <Button
            type="button"
            variant="outline"
            disabled={exchangeRatePending || editableUsdOrderIds.length === 0 || currentExchangeRate == null}
            onClick={saveExchangeRate}
          >
            保存并应用当前页
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          美元订单的产品实收、提成和运费实收均按此汇率结算为人民币；运费成本始终填写人民币。提交结清后汇率锁定。
        </span>
      </div>}

      <CustomerTagsLegend customerTags={customerTags} />

      {!readOnly && canManageCategoryRates && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
          <span className="text-sm text-muted-foreground">已选 {selectedCount} 个产品行</span>
          <Button
            type="button"
            disabled={selectedCount === 0 || submitPending}
            onClick={() => setDialogOpen(true)}
          >
            <CheckCircle2 className="mr-1.5 h-4 w-4" />
            提交结清
          </Button>
          <span className="text-xs text-muted-foreground">
            仅“已收齐且已发货”的产品行可提交；已结清行不可重复选择。
          </span>
        </div>
      )}

      {!readOnly && isSalespersonView && confirmationSelectableRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
          <span className="text-sm text-muted-foreground">已选 {selectedConfirmationCount} 个待确认产品行</span>
          <Button
            type="button"
            disabled={selectedConfirmationCount === 0 || confirmPending}
            onClick={confirmSelectedClearances}
          >
            <CheckCircle2 className="mr-1.5 h-4 w-4" />
            批量确认结清
          </Button>
          <span className="text-xs text-muted-foreground">仅可批量确认本人待确认的产品行。</span>
        </div>
      )}

      <form className="grid gap-3 rounded-md border p-4 md:grid-cols-4 xl:grid-cols-9">
        <input type="hidden" name="page" value="1" />
        <Input
          name="q"
          defaultValue={filters.q}
          placeholder="订单号/平台单号/发货单号/收款账户/产品/SKU"
          className="xl:col-span-2"
        />
        <DateRangePicker from={filters.dateFrom} to={filters.dateTo} className="md:col-span-2" />
        <MultiSelect
          name="shops"
          label="店铺"
          options={options.shops.map((shop) => ({ id: shop.id, name: shop.name }))}
          selected={filters.shops}
        />
        {!isSalespersonView && (
          <MultiSelect
            name="salespeople"
            label="业务员"
            options={options.salespeople.map((person) => ({
              id: person.id,
              name: displayProfileName(person),
            }))}
            selected={filters.salespeople}
          />
        )}
        <MultiSelect
          name="shopGroups"
          label="店铺分组"
          options={options.groups.map((group) => ({ id: group.id, name: group.name }))}
          selected={filters.shopGroups}
        />
        <div className="xl:col-span-2">
          <DisplayColumnSelector visibleColumns={visibleColumns} onToggle={toggleVisibleColumn} />
        </div>
        <div className="flex flex-wrap gap-2 xl:col-span-9">
          <Button type="submit">筛选</Button>
          <Button asChild type="button" variant="outline">
            <Link href="/finance/commission">清空</Link>
          </Button>
        </div>
      </form>

      <div className="overflow-hidden rounded-md border">
        <Table
          className="w-full min-w-[1300px] table-fixed text-sm [&_th]:h-9 [&_th]:whitespace-normal [&_th]:leading-4 [&_th]:px-2 [&_th]:py-1.5 [&_td]:px-2 [&_td]:py-1.5"
        >
          <TableHeader>
            <TableRow className="bg-background">
              {!readOnly && (
                <TableHead className="sticky top-0 z-20 w-9 bg-background shadow-sm">
                  {(isSalespersonView ? confirmationSelectableRows : selectableRows).length > 0 && (
                    <input
                      type="checkbox"
                      aria-label="全选"
                      checked={isSalespersonView ? allConfirmationSelected : allSelected}
                      onChange={(event) => {
                        if (isSalespersonView) toggleSelectAllConfirmation(event.target.checked)
                        else toggleSelectAll(event.target.checked)
                      }}
                    />
                  )}
                </TableHead>
              )}
              {OPTIONAL_COMMISSION_COLUMNS.filter(([column]) => visibleColumns.has(column)).map(([column, label]) => (
                <TableHead
                  key={label}
                  className={cn(
                    'sticky top-0 z-20 bg-background shadow-sm',
                    optionalCommissionColumnClassName(column),
                  )}
                >
                  {label}
                </TableHead>
              ))}
              {BUSINESS_ORDER_COMMISSION_COLUMNS.map((label) => (
                <TableHead
                  key={label}
                  className={cn(
                    'sticky top-0 z-20 bg-background shadow-sm',
                    commissionColumnClassName(label),
                  )}
                >
                  {label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group, groupIndex) => {
              const rowSpan = group.length
              return group.map((row, rowIndex) => {
                const isFirstRow = rowIndex === 0
                const displayOrderNumber = row.external_order_number || row.order_number
                return (
                  <TableRow
                    key={row.item_id}
                    className={isFirstRow && groupIndex > 0 ? 'border-t-2' : undefined}
                  >
                    {!readOnly && isFirstRow && (
                      <TableCell rowSpan={rowSpan} className={mergedCellClassName}>
                        <input
                          type="checkbox"
                          aria-label={`选择产品行 ${row.product_name}`}
                          checked={isSalespersonView
                            ? row.item_ids.every((id) => selectedConfirmationItemIds.has(id))
                            : row.item_ids.every((id) => selectedItemIds.has(id))}
                          disabled={isSalespersonView ? row.clearance_status !== 'pending' : !isClearanceSelectable(row)}
                          title={
                            isSalespersonView
                              ? row.clearance_status === 'pending'
                                ? '批量确认该产品行提成结清'
                                : '仅待确认的产品行可批量确认'
                              : !row.commission_calculable
                                ? '请先为订单关联客户'
                                : !hasCalculatedCommission(row)
                                  ? '请先保存美元兑人民币汇率，计算产品提成后再提交结清'
                                  : isClearanceSelectable(row)
                                    ? '提交该产品行提成结清'
                                    : '已结清的产品行不可重复选择'
                          }
                          onChange={(event) => {
                            if (isSalespersonView) toggleConfirmationRow(row, event.target.checked)
                            else toggleRow(row, event.target.checked)
                          }}
                        />
                      </TableCell>
                    )}
                    {isFirstRow && visibleColumns.has('order_number') && (
                      <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} ${optionalCommissionColumnClassName('order_number')}`}>{displayOrderNumber}</TableCell>
                    )}
                    {isFirstRow && visibleColumns.has('order_date') && (
                      <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} ${optionalCommissionColumnClassName('order_date')}`}>{row.order_date}</TableCell>
                    )}
                    {isFirstRow && visibleColumns.has('shipping_date') && (
                      <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} ${optionalCommissionColumnClassName('shipping_date')}`}>{row.shipping_date || '—'}</TableCell>
                    )}
                    {isFirstRow && visibleColumns.has('shop') && (
                      <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} ${optionalCommissionColumnClassName('shop')}`}>{row.shop_name || '—'}</TableCell>
                    )}
                    {isFirstRow && visibleColumns.has('shop_group') && (
                      <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} ${optionalCommissionColumnClassName('shop_group')}`}>{row.shop_group_name || '—'}</TableCell>
                    )}
                    {isFirstRow && visibleColumns.has('salesperson') && (
                      <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} ${optionalCommissionColumnClassName('salesperson')}`}>{row.salesperson_name}</TableCell>
                    )}
                    {isFirstRow && visibleColumns.has('custom_order_count') && (
                      <TableCell rowSpan={rowSpan} className={`${mergedCellClassName} ${optionalCommissionColumnClassName('custom_order_count')} tabular-nums`}>{row.custom_order_count}</TableCell>
                    )}
                    {visibleColumns.has('quantity') && (
                      <TableCell className={`${optionalCommissionColumnClassName('quantity')} tabular-nums`}>{quantityText(row.quantity)}</TableCell>
                    )}
                    {visibleColumns.has('unit_price') && (
                      <TableCell className={`${optionalCommissionColumnClassName('unit_price')} tabular-nums`}>{formatDailyMoney(row.unit_price, row.currency)}</TableCell>
                    )}
                    {isFirstRow && (
                      <TableCell
                        rowSpan={rowSpan}
                        className={mergedCellClassName}
                        style={{ color: row.customer_tag_color ?? undefined }}
                        title={row.customer_tag_label ?? undefined}
                      >
                        {row.commission_calculable ? (
                          row.customer_name || '—'
                        ) : (
                          <div>
                            <div>未关联客户</div>
                            <div className="text-xs text-muted-foreground">补充后可计算提成</div>
                          </div>
                        )}
                      </TableCell>
                    )}

                    <TableCell>
                      {row.shipping_category ? SHIPPING_LABELS[row.shipping_category] : '—'}
                    </TableCell>
                    <TableCell>
                      <ImagePreview src={row.image_url} alt={row.product_name} size="h-8 w-8" sizes="32px" />
                    </TableCell>
                    <TableCell className="w-52 min-w-52 max-w-52">
                      <div className="truncate" title={row.product_name}>{row.product_name}</div>
                      {row.product_sku && (
                        <div className="truncate text-xs text-muted-foreground" title={row.product_sku}>
                          {row.product_sku}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatCommissionMoney(row.product_received_amount, row, currentExchangeRate)}
                    </TableCell>
                    <TableCell>
                      <RateEditor
                        row={row}
                        readOnly={readOnly || isSalespersonView || !row.commission_calculable}
                      />
                    </TableCell>
                    <TableCell className="bg-sky-50 font-semibold text-sky-950 tabular-nums">
                      {formatCommissionMoney(row.product_commission_amount, row, currentExchangeRate)}
                    </TableCell>

                    {isFirstRow && (
                      <FreightEditor
                        row={row}
                        rowSpan={rowSpan}
                        readOnly={readOnly || isSalespersonView || !row.commission_calculable}
                        exchangeRate={currentExchangeRate}
                        defaultFreightCommissionRate={defaultFreightCommissionRate}
                      />
                    )}
                    <TableCell>
                      <div className="space-y-1">
                        <Badge variant={clearanceVariant(row.clearance_status)}>
                          {clearanceLabel(row.clearance_status)}
                        </Badge>
                        {row.clearance_period && (
                          <div className="text-xs text-muted-foreground">{row.clearance_period}</div>
                        )}
                        {!readOnly && row.clearance_status === 'pending' && canConfirmClearance && (
                          <div className="flex items-center gap-1 pt-1">
                            <Button type="button" variant="outline" size="sm" className="h-7 text-xs" disabled={confirmPending} onClick={() => confirmRowClearance(row)}>确认</Button>
                            <Button type="button" variant="outline" size="sm" className="h-7 text-xs text-destructive hover:bg-destructive hover:text-destructive-foreground" disabled={rejectPending} onClick={() => { setRejectingRow(row); setRejectReason('') }}>驳回</Button>
                          </div>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={BUSINESS_ORDER_COMMISSION_COLUMNS.length + visibleColumns.size + (readOnly ? 0 : 1)}
                  className="py-12 text-center text-muted-foreground"
                >
                  没有符合筛选条件的订单
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            共 {totalCount} 条订单，第 {currentPage}/{totalPages} 页
          </span>
          <div className="flex items-center gap-1">
            {currentPage > 1 && (
              <Link
                href={`/finance/commission?${businessOrderCommissionFilterQuery({ ...filters, page: currentPage - 1 })}`}
                className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted"
              >
                上一页
              </Link>
            )}
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 2)
              .reduce<(number | 'ellipsis')[]>((acc, p, i, arr) => {
                if (i > 0 && p - (arr[i - 1] as number) > 1) acc.push('ellipsis')
                acc.push(p)
                return acc
              }, [])
              .map((item, i) =>
                item === 'ellipsis' ? (
                  <span key={`e${i}`} className="px-1 text-muted-foreground">…</span>
                ) : (
                  <Link
                    key={item}
                    href={`/finance/commission?${businessOrderCommissionFilterQuery({ ...filters, page: item })}`}
                    className={`inline-flex h-8 min-w-8 items-center justify-center rounded-md text-sm ${
                      item === currentPage
                        ? 'bg-primary text-primary-foreground'
                        : 'border hover:bg-muted'
                    }`}
                  >
                    {item}
                  </Link>
                ),
              )}
            {currentPage < totalPages && (
              <Link
                href={`/finance/commission?${businessOrderCommissionFilterQuery({ ...filters, page: currentPage + 1 })}`}
                className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted"
              >
                下一页
              </Link>
            )}
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>提交提成结清</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              已选择 {selectedCount} 个产品行，请选择结清归属年月后提交。
            </p>
            <div>
              <label htmlFor="clearance-period" className="block text-sm font-medium">
                结清年月
              </label>
              <Input
                id="clearance-period"
                type="month"
                value={period}
                onChange={(event) => setPeriod(event.target.value)}
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button type="button" disabled={submitPending} onClick={confirmSubmitClearance}>
              确认提交
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={rejectingRow != null}
        onOpenChange={(open) => {
          if (!open) {
            setRejectingRow(null)
            setRejectReason('')
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>驳回提成结清</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              订单 {rejectingRow?.order_number} 的 {rejectingRow?.product_name} 将被驳回，请填写原因。
            </p>
            <div>
              <label htmlFor="reject-reason" className="block text-sm font-medium">
                驳回原因
              </label>
              <Textarea
                id="reject-reason"
                value={rejectReason}
                placeholder="请填写驳回原因"
                maxLength={500}
                onChange={(event) => setRejectReason(event.target.value)}
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setRejectingRow(null)
                setRejectReason('')
              }}
            >
              取消
            </Button>
            <Button type="button" disabled={rejectPending} onClick={submitRowRejection}>
              确认驳回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
