'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { BUSINESS_FULFILLMENT_LABELS } from '@/lib/business-orders'
import { SHIPPING_LABELS } from '@/lib/daily-orders'
import { formatCny } from '@/lib/finance'
import { cn, formatCurrency } from '@/lib/utils'
import type { BusinessPerformanceFilters } from '@/lib/actions/business-orders'
import type {
  BusinessFulfillmentType,
  BusinessPerformanceGroupBy,
  BusinessPerformanceGroupRow,
  BusinessPerformanceSummary,
  DailyOrderShippingCategory,
} from '@/types'

function formatOriginal(amount: number, currency: string | null) {
  if (currency) {
    return formatCurrency(amount, currency)
  }
  return `${amount.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} (多币种)`
}

interface Option {
  value: string
  label: string
}

interface PerformanceManagerProps {
  summary: BusinessPerformanceSummary
  groupRows: BusinessPerformanceGroupRow[]
  groupBy: BusinessPerformanceGroupBy
  filters: BusinessPerformanceFilters
  salespeople: Option[]
  shops: Option[]
}

const GROUP_TABS: { value: BusinessPerformanceGroupBy; label: string }[] = [
  { value: 'salesperson', label: '业务' },
  { value: 'shop', label: '渠道' },
  { value: 'date', label: '日期' },
  { value: 'month', label: '月份' },
  { value: 'fulfillment_type', label: '订单属性' },
  { value: 'shipping_category', label: '发货分类' },
]

const GROUP_COLUMN_LABELS: Record<BusinessPerformanceGroupBy, string> = {
  salesperson: '业务',
  shop: '渠道',
  date: '日期',
  month: '月份',
  fulfillment_type: '订单属性',
  shipping_category: '发货分类',
}

const FULFILLMENT_OPTIONS: Option[] = [
  { value: 'custom', label: BUSINESS_FULFILLMENT_LABELS.custom },
  { value: 'stock', label: BUSINESS_FULFILLMENT_LABELS.stock },
]

const SHIPPING_OPTIONS: Option[] = [
  { value: 'custom', label: SHIPPING_LABELS.custom },
  { value: 'stock', label: SHIPPING_LABELS.stock },
  { value: 'sample', label: SHIPPING_LABELS.sample },
  { value: 'purchase', label: SHIPPING_LABELS.purchase },
]

function MultiSelect({
  options,
  value,
  onChange,
  placeholder,
}: {
  options: Option[]
  value: string[]
  onChange: (value: string[]) => void
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  const selectedLabels = options
    .filter((option) => value.includes(option.value))
    .map((option) => option.label)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">
            {selectedLabels.length > 0 ? selectedLabels.join('、') : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-0">
        <Command>
          <CommandInput placeholder="搜索..." />
          <CommandList>
            <CommandEmpty>无匹配选项</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const selected = value.includes(option.value)
                return (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    onSelect={() => {
                      onChange(
                        selected
                          ? value.filter((item) => item !== option.value)
                          : [...value, option.value],
                      )
                    }}
                  >
                    <div
                      className={cn(
                        'mr-2 flex h-4 w-4 items-center justify-center rounded-sm border',
                        selected && 'bg-primary border-primary',
                      )}
                    >
                      {selected && (
                        <Check className="h-3 w-3 text-primary-foreground" />
                      )}
                    </div>
                    <span>{option.label}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function PerformanceManager({
  summary,
  groupRows,
  groupBy,
  filters,
  salespeople,
  shops,
}: PerformanceManagerProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [dateFrom, setDateFrom] = useState(filters.dateFrom ?? '')
  const [dateTo, setDateTo] = useState(filters.dateTo ?? '')
  const [selectedSalespeople, setSelectedSalespeople] = useState(
    filters.salespersonIds ?? [],
  )
  const [selectedShops, setSelectedShops] = useState(filters.shopIds ?? [])
  const [selectedFulfillment, setSelectedFulfillment] = useState(
    filters.fulfillmentTypes ?? [],
  )
  const [selectedShipping, setSelectedShipping] = useState(
    filters.shippingCategories ?? [],
  )

  function buildUrl(overrides: { groupBy?: BusinessPerformanceGroupBy } = {}) {
    const params = new URLSearchParams()
    if (dateFrom) params.set('dateFrom', dateFrom)
    if (dateTo) params.set('dateTo', dateTo)
    if (selectedSalespeople.length > 0) {
      params.set('salesperson', selectedSalespeople.join(','))
    }
    if (selectedShops.length > 0) {
      params.set('shop', selectedShops.join(','))
    }
    if (selectedFulfillment.length > 0) {
      params.set('fulfillment', selectedFulfillment.join(','))
    }
    if (selectedShipping.length > 0) {
      params.set('shipping', selectedShipping.join(','))
    }
    params.set('groupBy', overrides.groupBy ?? groupBy)
    const qs = params.toString()
    return `/finance/performance${qs ? `?${qs}` : ''}`
  }

  function navigate(url: string) {
    startTransition(() => {
      router.push(url)
    })
  }

  function clearFilters() {
    setDateFrom('')
    setDateTo('')
    setSelectedSalespeople([])
    setSelectedShops([])
    setSelectedFulfillment([])
    setSelectedShipping([])
    navigate('/finance/performance')
  }

  return (
    <div className={cn('space-y-4', pending && 'opacity-70')}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">筛选订单数</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {Number(summary.order_count)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">订单总额（CNY）</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {formatCny(Number(summary.order_total_cny))}
            </div>
            {summary.currency !== undefined && (
              <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                = {formatOriginal(Number(summary.order_total_amount), summary.currency)}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">已收（CNY）</div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-green-700">
              {formatCny(Number(summary.received_cny))}
            </div>
            {summary.currency !== undefined && (
              <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                = {formatOriginal(Number(summary.received_amount), summary.currency)}
              </div>
            )}
          </CardContent>
        </Card>
        <Card className={Number(summary.overdue_count) > 0 ? 'border-destructive/40' : undefined}>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">未收 / 逾期订单</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {formatCny(Number(summary.outstanding_cny))}{' '}
              <span
                className={
                  Number(summary.overdue_count) > 0
                    ? 'text-sm text-destructive'
                    : 'text-sm text-muted-foreground'
                }
              >
                / {Number(summary.overdue_count)} 单
              </span>
            </div>
            {summary.currency !== undefined && (
              <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                = {formatOriginal(Number(summary.outstanding_amount), summary.currency)}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-3 rounded-md border bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">开始日期</label>
            <Input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">结束日期</label>
            <Input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">业务</label>
            <MultiSelect
              options={salespeople}
              value={selectedSalespeople}
              onChange={setSelectedSalespeople}
              placeholder="全部业务"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">渠道</label>
            <MultiSelect
              options={shops}
              value={selectedShops}
              onChange={setSelectedShops}
              placeholder="全部渠道"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">订单属性</label>
            <MultiSelect
              options={FULFILLMENT_OPTIONS}
              value={selectedFulfillment}
              onChange={(value) =>
                setSelectedFulfillment(value as BusinessFulfillmentType[])
              }
              placeholder="全部属性"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">发货分类</label>
            <MultiSelect
              options={SHIPPING_OPTIONS}
              value={selectedShipping}
              onChange={(value) =>
                setSelectedShipping(value as DailyOrderShippingCategory[])
              }
              placeholder="全部分类"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => navigate(buildUrl())}>筛选</Button>
          <Button variant="outline" onClick={clearFilters}>
            清空
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {GROUP_TABS.map((tab) => (
          <Button
            key={tab.value}
            variant={groupBy === tab.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => navigate(buildUrl({ groupBy: tab.value }))}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-md border">
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead>{GROUP_COLUMN_LABELS[groupBy]}</TableHead>
              <TableHead className="text-right">订单数</TableHead>
              <TableHead className="text-right">订单总额（原币）</TableHead>
              <TableHead className="text-right">订单总额（CNY）</TableHead>
              <TableHead className="text-right">已收（原币）</TableHead>
              <TableHead className="text-right">已收（CNY）</TableHead>
              <TableHead className="text-right">未收（原币）</TableHead>
              <TableHead className="text-right">未收（CNY）</TableHead>
              <TableHead className="text-right">逾期订单</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groupRows.map((row) => (
              <TableRow key={row.group_key}>
                <TableCell className="font-medium">{row.group_label}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {Number(row.order_count)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatOriginal(Number(row.order_total_amount), row.currency)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCny(Number(row.order_total_cny))}
                </TableCell>
                <TableCell className="text-right tabular-nums text-green-700">
                  {formatOriginal(Number(row.received_amount), row.currency)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-green-700">
                  {formatCny(Number(row.received_cny))}
                </TableCell>
                <TableCell
                  className={cn(
                    'text-right tabular-nums',
                    Number(row.outstanding_cny) > 0.005 && 'text-destructive',
                  )}
                >
                  {formatOriginal(Number(row.outstanding_amount), row.currency)}
                </TableCell>
                <TableCell
                  className={cn(
                    'text-right tabular-nums',
                    Number(row.outstanding_cny) > 0.005 && 'text-destructive',
                  )}
                >
                  {formatCny(Number(row.outstanding_cny))}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {Number(row.overdue_count) > 0 ? (
                    <span className="text-destructive">{Number(row.overdue_count)}</span>
                  ) : (
                    Number(row.overdue_count)
                  )}
                </TableCell>
              </TableRow>
            ))}
            {groupRows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="py-12 text-center text-muted-foreground"
                >
                  暂无符合条件的数据
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
