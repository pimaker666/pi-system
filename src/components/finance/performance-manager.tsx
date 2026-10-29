'use client'

import Link from 'next/link'
import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronsUpDown, Download } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DateRangePicker } from '@/components/shared/date-range-picker'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { SHIPPING_LABELS } from '@/lib/daily-orders'
import { formatCny } from '@/lib/finance'
import type { BusinessOrderProfitRow } from '@/lib/actions/business-order-profit'
import { cn, formatCurrency } from '@/lib/utils'
import type { BusinessPerformanceFilters } from '@/lib/actions/business-orders'
import type {
  BusinessPerformanceDimension,
  BusinessPerformanceGroupBy,
  BusinessPerformanceGroupRow,
  BusinessPerformanceMultiDimensionRow,
  BusinessPerformanceProductRow,
  BusinessPerformanceSummary,
  DailyOrderShippingCategory,
} from '@/types'

interface Option {
  value: string
  label: string
}

interface PerformanceManagerProps {
  summary: BusinessPerformanceSummary
  groupRows: BusinessPerformanceGroupRow[]
  productRows: BusinessPerformanceProductRow[]
  multiDimensionRows: BusinessPerformanceMultiDimensionRow[]
  multiDimensions: [BusinessPerformanceDimension, BusinessPerformanceDimension | null, BusinessPerformanceDimension | null]
  groupBy: BusinessPerformanceGroupBy
  filters: BusinessPerformanceFilters
  salespeople: Option[]
  shops: Option[]
  productGroups: Option[]
  profitRows: BusinessOrderProfitRow[]
  canViewProfit: boolean
}

const GROUP_TABS: { value: BusinessPerformanceGroupBy; label: string }[] = [
  { value: 'salesperson', label: '业务' },
  { value: 'shop', label: '渠道' },
  { value: 'date', label: '日期' },
  { value: 'month', label: '月份' },
  { value: 'product_group', label: '产品分组' },
  { value: 'shipping_category', label: '发货分类' },
  { value: 'country', label: '国家' },
  { value: 'catalog_product', label: '普通产品' },
  { value: 'custom_product', label: '定制产品' },
]

const GROUP_COLUMN_LABELS: Record<BusinessPerformanceGroupBy, string> = {
  salesperson: '业务',
  shop: '渠道',
  date: '日期',
  month: '月份',
  product_group: '产品分组',
  shipping_category: '发货分类',
  country: '国家',
  catalog_product: '普通产品',
  custom_product: '定制产品',
}

const SHIPPING_OPTIONS: Option[] = [
  { value: 'custom', label: SHIPPING_LABELS.custom },
  { value: 'stock', label: SHIPPING_LABELS.stock },
  { value: 'sample', label: SHIPPING_LABELS.sample },
  { value: 'custom_sample', label: SHIPPING_LABELS.custom_sample },
  { value: 'purchase', label: SHIPPING_LABELS.purchase },
]

const DIMENSION_OPTIONS: { value: BusinessPerformanceDimension; label: string }[] = [
  { value: 'salesperson', label: '业务' },
  { value: 'shop', label: '渠道' },
  { value: 'country', label: '国家' },
  { value: 'product', label: '产品' },
  { value: 'product_group', label: '产品分组' },
  { value: 'shipping_category', label: '发货分类' },
  { value: 'date', label: '日期' },
  { value: 'month', label: '月份' },
]

function formatUsd(amount: number) {
  return formatCurrency(amount, 'USD')
}

// 业绩页两个汇总板块统一整数展示（四舍五入，不保留小数）。
const wholeNumberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function roundWhole(value: number) {
  return Number.isFinite(value) ? Math.round(value) : 0
}

function formatCnyWhole(value: number) {
  return Number.isFinite(value) ? `¥${wholeNumberFormat.format(Math.round(value))}` : '—'
}

function formatUsdWhole(value: number) {
  return Number.isFinite(value) ? `$${wholeNumberFormat.format(Math.round(value))}` : '—'
}

function formatQuantityWhole(value: number) {
  return Number.isFinite(value) ? wholeNumberFormat.format(Math.round(value)) : '—'
}

function multiDimensionValue(
  row: BusinessPerformanceMultiDimensionRow,
  index: 0 | 1 | 2,
): Option | null {
  const key = index === 0
    ? row.dimension_1_key
    : index === 1
      ? row.dimension_2_key
      : row.dimension_3_key
  const label = index === 0
    ? row.dimension_1_label
    : index === 1
      ? row.dimension_2_label
      : row.dimension_3_label

  return key === null || label === null ? null : { value: key, label }
}

function MultiSelect({
  options,
  value,
  onChange,
  placeholder,
  className,
}: {
  options: Option[]
  value: string[]
  onChange: (value: string[]) => void
  placeholder: string
  className?: string
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
          className={cn('w-full justify-between font-normal', className)}
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

function ProductPerformanceTable({ rows }: { rows: BusinessPerformanceProductRow[] }) {
  const hasUnsettled = rows.some(
    (row) => row.unsettled_line_count > 0 || row.missing_exchange_rate_line_count > 0,
  )
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table className="min-w-[1300px]">
        <TableHeader>
          <TableRow>
            <TableHead>产品</TableHead>
            <TableHead className="text-right">销售数量</TableHead>
            <TableHead className="text-right">销售金额（CNY）</TableHead>
            {hasUnsettled && <TableHead className="text-right">销售金额（USD）</TableHead>}
            <TableHead className="text-right">平均客单价（CNY）</TableHead>
            {hasUnsettled && <TableHead className="text-right">平均客单价（USD）</TableHead>}
            <TableHead className="text-right">产品总成本（CNY）</TableHead>
            <TableHead className="text-right">产品总利润（CNY）</TableHead>
            <TableHead>结算状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const settled = row.unsettled_line_count === 0 && row.missing_exchange_rate_line_count === 0
            const cnySalesAmount = hasUnsettled ? row.sales_amount_cny : row.settled_sales_amount_cny
            const cnyAverage = hasUnsettled
              ? (row.sales_quantity ? row.sales_amount_cny / row.sales_quantity : 0)
              : (row.settled_quantity ? row.settled_sales_amount_cny / row.settled_quantity : 0)
            const usdAverage = row.sales_quantity ? row.sales_amount_usd / row.sales_quantity : 0
            return (
              <TableRow key={row.product_key}>
                <TableCell>
                  <div className="font-medium">{row.product_name}</div>
                  {row.product_sku && <div className="text-xs text-muted-foreground">{row.product_sku}</div>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatQuantityWhole(row.sales_quantity)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCnyWhole(cnySalesAmount)}</TableCell>
                {hasUnsettled && <TableCell className="text-right tabular-nums">{formatUsdWhole(row.sales_amount_usd)}</TableCell>}
                <TableCell className="text-right tabular-nums">{formatCnyWhole(cnyAverage)}</TableCell>
                {hasUnsettled && <TableCell className="text-right tabular-nums">{formatUsdWhole(usdAverage)}</TableCell>}
                <TableCell className="text-right tabular-nums">{formatCnyWhole(row.settled_product_cost_cny)}</TableCell>
                <TableCell className="text-right tabular-nums font-medium text-green-700">{formatCnyWhole(row.settled_product_profit_cny)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {settled
                    ? '已结清'
                    : row.missing_exchange_rate_line_count > 0
                      ? '待补结清汇率'
                      : `含 ${row.unsettled_line_count} 条未结算行`}
                </TableCell>
              </TableRow>
            )
          })}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={hasUnsettled ? 9 : 7} className="py-12 text-center text-muted-foreground">暂无符合筛选条件的数据</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

export function PerformanceManager({
  summary,
  groupRows,
  productRows,
  multiDimensionRows,
  multiDimensions,
  groupBy,
  filters,
  salespeople,
  shops,
  productGroups,
  profitRows,
  canViewProfit,
}: PerformanceManagerProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [dateFrom, setDateFrom] = useState(filters.dateFrom ?? '')
  const [dateTo, setDateTo] = useState(filters.dateTo ?? '')
  const [selectedSalespeople, setSelectedSalespeople] = useState(
    filters.salespersonIds ?? [],
  )
  const [selectedShops, setSelectedShops] = useState(filters.shopIds ?? [])
  const [selectedProductGroups, setSelectedProductGroups] = useState(
    filters.productGroupIds ?? [],
  )
  const [selectedShipping, setSelectedShipping] = useState(
    filters.shippingCategories ?? [],
  )
  const [exchangeRate, setExchangeRate] = useState('')
  const [selectedDimensions, setSelectedDimensions] = useState(multiDimensions)
  const [selectedDimensionValues, setSelectedDimensionValues] = useState<[string[], string[], string[]]>([[], [], []])
  const [exporting, setExporting] = useState<'group' | 'multi' | null>(null)

  const rate = useMemo(() => {
    const value = Number(exchangeRate)
    return Number.isFinite(value) && value > 0 ? value : null
  }, [exchangeRate])
  const isProductView = groupBy === 'catalog_product' || groupBy === 'custom_product'

  function buildUrl(overrides: {
    groupBy?: BusinessPerformanceGroupBy
    dimensions?: [BusinessPerformanceDimension, BusinessPerformanceDimension | null, BusinessPerformanceDimension | null]
  } = {}) {
    const params = new URLSearchParams()
    if (dateFrom) params.set('dateFrom', dateFrom)
    if (dateTo) params.set('dateTo', dateTo)
    if (selectedSalespeople.length > 0) {
      params.set('salesperson', selectedSalespeople.join(','))
    }
    if (selectedShops.length > 0) {
      params.set('shop', selectedShops.join(','))
    }
    if (selectedProductGroups.length > 0) {
      params.set('productGroup', selectedProductGroups.join(','))
    }
    if (selectedShipping.length > 0) {
      params.set('shipping', selectedShipping.join(','))
    }
    params.set('groupBy', overrides.groupBy ?? groupBy)
    const dimensions = overrides.dimensions ?? selectedDimensions
    params.set('dimension1', dimensions[0])
    if (dimensions[1]) params.set('dimension2', dimensions[1])
    if (dimensions[2]) params.set('dimension3', dimensions[2])
    const qs = params.toString()
    return `/finance/performance${qs ? `?${qs}` : ''}`
  }

  function navigate(url: string) {
    startTransition(() => {
      router.push(url, { scroll: false })
    })
  }

  function clearFilters() {
    setDateFrom('')
    setDateTo('')
    setSelectedSalespeople([])
    setSelectedShops([])
    setSelectedProductGroups([])
    setSelectedShipping([])
    navigate('/finance/performance')
  }

  function updateDimension(index: 0 | 1 | 2, value: BusinessPerformanceDimension | null) {
    const next = [...selectedDimensions] as [
      BusinessPerformanceDimension,
      BusinessPerformanceDimension | null,
      BusinessPerformanceDimension | null,
    ]
    if (index === 0 && value) next[0] = value
    if (index === 1) next[1] = value
    if (index === 2) next[2] = value

    const used = new Set<BusinessPerformanceDimension>()
    next.forEach((dimension, position) => {
      if (!dimension) return
      if (used.has(dimension)) next[position] = null
      else used.add(dimension)
    })
    setSelectedDimensions(next)
    setSelectedDimensionValues([[], [], []])
    navigate(buildUrl({ dimensions: next }))
  }

  const multiDimensionOptions = useMemo(() => {
    return ([0, 1, 2] as const).map((index) => {
      if (!multiDimensions[index]) return []
      const values = new Map<string, string>()
      multiDimensionRows.forEach((row) => {
        const value = multiDimensionValue(row, index)
        if (value) values.set(value.value, value.label)
      })
      return [...values].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
    })
  }, [multiDimensionRows, multiDimensions])

  const filteredMultiDimensionRows = useMemo(() => {
    return multiDimensionRows.filter((row) => {
      return ([0, 1, 2] as const).every((index) => {
        const selected = selectedDimensionValues[index]
        return selected.length === 0 || selected.includes(multiDimensionValue(row, index)?.value ?? '')
      })
    })
  }, [multiDimensionRows, selectedDimensionValues])

  const consolidatedOrderTotal = rate
    ? summary.order_total_cny_native + summary.order_total_usd * rate
    : null
  const consolidatedReceived = rate
    ? summary.received_cny_native + summary.received_usd * rate
    : null
  const consolidatedOutstanding = rate
    ? summary.outstanding_cny_native + summary.outstanding_usd * rate
    : null

  const sortedRows = useMemo(() => {
    return [...groupRows].sort((a, b) => {
      const aTotal = rate
        ? a.order_total_cny_native + a.order_total_usd * rate
        : a.order_total_cny
      const bTotal = rate
        ? b.order_total_cny_native + b.order_total_usd * rate
        : b.order_total_cny
      return bTotal - aTotal
    })
  }, [groupRows, rate])

  const isItemLevelGroup = groupBy === 'product_group' || groupBy === 'shipping_category'
  const amountLabel = isItemLevelGroup ? '产品金额' : '订单总额'

  const groupTotals = useMemo(() => {
    return sortedRows.reduce(
      (acc, row) => {
        acc.orderCount += Number(row.order_count)
        acc.overdueCount += Number(row.overdue_count)
        acc.cnyTotal += Number(row.order_total_cny_native)
        acc.usdTotal += Number(row.order_total_usd)
        acc.cnyReceived += Number(row.received_cny_native)
        acc.usdReceived += Number(row.received_usd)
        acc.cnyOutstanding += Number(row.outstanding_cny_native)
        acc.usdOutstanding += Number(row.outstanding_usd)
        return acc
      },
      {
        orderCount: 0,
        overdueCount: 0,
        cnyTotal: 0,
        usdTotal: 0,
        cnyReceived: 0,
        usdReceived: 0,
        cnyOutstanding: 0,
        usdOutstanding: 0,
      },
    )
  }, [sortedRows])

  const multiDimensionLabels = multiDimensions
    .filter((dimension): dimension is BusinessPerformanceDimension => dimension !== null)
    .map((dimension) => DIMENSION_OPTIONS.find((option) => option.value === dimension)?.label ?? dimension)

  const exportScope = dateFrom || dateTo
    ? `${dateFrom || '不限'}至${dateTo || '不限'}`
    : '全部日期'

  async function downloadTableExport(
    payload: {
      fileName: string
      sheetName: string
      columns: string[]
      rows: Array<Array<string | number | null>>
      totalRow?: Array<string | number | null>
    },
    scope: 'group' | 'multi',
  ) {
    if (exporting) return
    setExporting(scope)
    try {
      const response = await fetch('/api/finance/performance/export/xlsx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        let message = `导出失败（${response.status}）`
        try {
          const data = (await response.json()) as { error?: string }
          if (data?.error) message = data.error
        } catch {
          // 错误体不是 JSON 时保留默认提示
        }
        toast.error(message)
        return
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = payload.fileName
      link.click()
      URL.revokeObjectURL(url)
      toast.success('已导出完整表格')
    } catch {
      toast.error('导出失败，请稍后重试')
    } finally {
      setExporting(null)
    }
  }

  function fileNameFor(prefix: string) {
    return `${prefix.replace(/[\\/:*?"<>|]/g, '_')}_${exportScope}.xlsx`
  }

  function exportGroupTable() {
    if (isProductView) {
      exportProductTable()
      return
    }
    const columns = [
      GROUP_COLUMN_LABELS[groupBy],
      '订单数',
      ...(rate
        ? [`${amountLabel}（CNY）`, '已收（CNY）', '未收（CNY）']
        : [
            `${amountLabel}（CNY）`,
            `${amountLabel}（USD）`,
            '已收（CNY）',
            '已收（USD）',
            '未收（CNY）',
            '未收（USD）',
          ]),
      '逾期订单',
    ]
    const rows = sortedRows.map((row) => {
      const values: Array<string | number> = [row.group_label, Number(row.order_count)]
      if (rate) {
        values.push(
          roundWhole(Number(row.order_total_cny_native) + Number(row.order_total_usd) * rate),
          roundWhole(Number(row.received_cny_native) + Number(row.received_usd) * rate),
          roundWhole(Number(row.outstanding_cny_native) + Number(row.outstanding_usd) * rate),
        )
      } else {
        values.push(
          roundWhole(Number(row.order_total_cny_native)),
          roundWhole(Number(row.order_total_usd)),
          roundWhole(Number(row.received_cny_native)),
          roundWhole(Number(row.received_usd)),
          roundWhole(Number(row.outstanding_cny_native)),
          roundWhole(Number(row.outstanding_usd)),
        )
      }
      values.push(Number(row.overdue_count))
      return values
    })
    const totalRow: Array<string | number> = [
      '合计',
      isItemLevelGroup ? '—' : groupTotals.orderCount,
    ]
    if (rate) {
      totalRow.push(
        roundWhole(groupTotals.cnyTotal + groupTotals.usdTotal * rate),
        roundWhole(groupTotals.cnyReceived + groupTotals.usdReceived * rate),
        roundWhole(groupTotals.cnyOutstanding + groupTotals.usdOutstanding * rate),
      )
    } else {
      totalRow.push(
        roundWhole(groupTotals.cnyTotal),
        roundWhole(groupTotals.usdTotal),
        roundWhole(groupTotals.cnyReceived),
        roundWhole(groupTotals.usdReceived),
        roundWhole(groupTotals.cnyOutstanding),
        roundWhole(groupTotals.usdOutstanding),
      )
    }
    totalRow.push(isItemLevelGroup ? '—' : groupTotals.overdueCount)
    downloadTableExport(
      {
        fileName: fileNameFor(`业务业绩_${GROUP_COLUMN_LABELS[groupBy]}`),
        sheetName: '业务业绩',
        columns,
        rows,
        totalRow,
      },
      'group',
    )
  }

  function exportProductTable() {
    const hasUnsettledRows = productRows.some(
      (row) => row.unsettled_line_count > 0 || row.missing_exchange_rate_line_count > 0,
    )
    const columns = [
      '产品',
      '销售数量',
      '销售金额（CNY）',
      ...(hasUnsettledRows ? ['销售金额（USD）'] : []),
      '平均客单价（CNY）',
      ...(hasUnsettledRows ? ['平均客单价（USD）'] : []),
      '产品总成本（CNY）',
      '产品总利润（CNY）',
      '结算状态',
    ]
    const rows = productRows.map((row) => {
      const cnySalesAmount = hasUnsettledRows ? row.sales_amount_cny : row.settled_sales_amount_cny
      const cnyAverage = hasUnsettledRows
        ? (row.sales_quantity ? row.sales_amount_cny / row.sales_quantity : 0)
        : (row.settled_quantity ? row.settled_sales_amount_cny / row.settled_quantity : 0)
      const usdAverage = row.sales_quantity ? row.sales_amount_usd / row.sales_quantity : 0
      const settled = row.unsettled_line_count === 0 && row.missing_exchange_rate_line_count === 0
      const values: Array<string | number> = [
        row.product_sku ? `${row.product_name}（${row.product_sku}）` : row.product_name,
        roundWhole(row.sales_quantity),
        roundWhole(cnySalesAmount),
      ]
      if (hasUnsettledRows) values.push(roundWhole(row.sales_amount_usd))
      values.push(roundWhole(cnyAverage))
      if (hasUnsettledRows) values.push(roundWhole(usdAverage))
      values.push(
        roundWhole(row.settled_product_cost_cny),
        roundWhole(row.settled_product_profit_cny),
        settled
          ? '已结清'
          : row.missing_exchange_rate_line_count > 0
            ? '待补结清汇率'
            : `含 ${row.unsettled_line_count} 条未结算行`,
      )
      return values
    })
    downloadTableExport(
      {
        fileName: fileNameFor(`业务业绩_${GROUP_COLUMN_LABELS[groupBy]}`),
        sheetName: '业务业绩',
        columns,
        rows,
      },
      'group',
    )
  }

  function exportMultiDimensionTable() {
    const columns = [
      ...multiDimensionLabels,
      '订单数',
      '销售数量',
      '产品销售额（不含运费，CNY）',
      '产品销售额（不含运费，USD）',
    ]
    const rows = filteredMultiDimensionRows.map((row) => {
      const values: Array<string | number | null> = [row.dimension_1_label]
      if (multiDimensions[1]) values.push(row.dimension_2_label)
      if (multiDimensions[2]) values.push(row.dimension_3_label)
      values.push(
        Number(row.order_count),
        roundWhole(row.sales_quantity),
        roundWhole(row.sales_amount_cny),
        roundWhole(row.sales_amount_usd),
      )
      return values
    })
    downloadTableExport(
      {
        fileName: fileNameFor(`多维销售总览_${multiDimensionLabels.join('-')}`),
        sheetName: '多维销售总览',
        columns,
        rows,
      },
      'multi',
    )
  }

  const hasUsd =
    summary.order_total_usd > 0 ||
    summary.received_usd > 0 ||
    summary.outstanding_usd > 0

  const profitSummary = useMemo(() => {
    const initial = {
      CNY: { orderCount: 0, received: 0, deductions: 0, profit: 0 },
      USD: { orderCount: 0, received: 0, deductions: 0, profit: 0 },
    }
    return profitRows.reduce((result, row) => {
      const target = result[row.currency]
      target.orderCount += 1
      target.received += row.received_amount
      target.deductions += row.product_cost + row.freight_cost + row.commission_amount + row.fee_amount
      target.profit += row.profit_amount
      return result
    }, initial)
  }, [profitRows])
  const consolidatedProfit = rate
    ? profitSummary.CNY.profit + profitSummary.USD.profit * rate
    : null
  const hasProfitUsd = profitSummary.USD.orderCount > 0

  return (
    <div className={cn('space-y-4', pending && 'opacity-70')}>
      <div className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
        <label className="text-sm font-medium text-muted-foreground">
          USD→CNY 汇率
        </label>
        <Input
          type="number"
          step="0.0001"
          min="0"
          placeholder="填写后美金按此汇率折算为人民币"
          value={exchangeRate}
          onChange={(event) => setExchangeRate(event.target.value)}
          className="w-[240px] border-amber-300 bg-amber-50 font-semibold text-amber-950 focus-visible:ring-amber-400"
        />
        {rate && (
          <span className="text-sm text-muted-foreground">当前汇率：{rate}</span>
        )}
      </div>

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
            <div className="text-xs text-muted-foreground">订单总额</div>
            {rate ? (
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {formatCny(Number(consolidatedOrderTotal))}
              </div>
            ) : (
              <>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {formatCny(Number(summary.order_total_cny_native))}
                </div>
                {hasUsd && (
                  <div className="mt-1 text-xl font-semibold tabular-nums">
                    {formatUsd(Number(summary.order_total_usd))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">已收</div>
            {rate ? (
              <div className="mt-1 text-xl font-semibold tabular-nums text-green-700">
                {formatCny(Number(consolidatedReceived))}
              </div>
            ) : (
              <>
                <div className="mt-1 text-xl font-semibold tabular-nums text-green-700">
                  {formatCny(Number(summary.received_cny_native))}
                </div>
                {hasUsd && (
                  <div className="mt-1 text-xl font-semibold tabular-nums text-green-700">
                    {formatUsd(Number(summary.received_usd))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
        <Card className={Number(summary.overdue_count) > 0 ? 'border-destructive/40' : undefined}>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">未收 / 逾期订单</div>
            {rate ? (
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {formatCny(Number(consolidatedOutstanding))}{' '}
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
            ) : (
              <>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {formatCny(Number(summary.outstanding_cny_native))}{' '}
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
                {hasUsd && (
                  <div className="mt-1 text-xl font-semibold tabular-nums">
                    {formatUsd(Number(summary.outstanding_usd))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {canViewProfit && (
        <Card>
          <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs text-muted-foreground">双结清订单利润</div>
              {rate ? (
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {formatCny(consolidatedProfit ?? 0)}
                </div>
              ) : (
                <>
                  <div className="mt-1 text-xl font-semibold tabular-nums">
                    {formatCny(profitSummary.CNY.profit)}
                  </div>
                  {hasProfitUsd && (
                    <div className="mt-0.5 text-sm font-medium tabular-nums">
                      {formatUsd(profitSummary.USD.profit)}
                    </div>
                  )}
                </>
              )}
              <div className="mt-1 text-sm text-muted-foreground">
                {profitSummary.CNY.orderCount + profitSummary.USD.orderCount} 单 · 实收{' '}
                {formatCny(profitSummary.CNY.received)}
                {hasProfitUsd && ` / ${formatUsd(profitSummary.USD.received)}`} · 扣减{' '}
                {formatCny(profitSummary.CNY.deductions)}
                {hasProfitUsd && ` / ${formatUsd(profitSummary.USD.deductions)}`}
              </div>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/finance/profit">进入利润核算</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <div className="space-y-1.5 sm:col-span-2">
            <label className="text-xs font-medium text-muted-foreground">下单日期</label>
            <DateRangePicker from={dateFrom} to={dateTo} onChange={({ from, to }) => {
              setDateFrom(from)
              setDateTo(to)
            }} className="w-full" />
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
            <label className="text-xs font-medium text-muted-foreground">产品分组</label>
            <MultiSelect
              options={productGroups}
              value={selectedProductGroups}
              onChange={setSelectedProductGroups}
              placeholder="全部分组"
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

      <div className="flex flex-wrap items-center gap-2">
        {GROUP_TABS.filter((tab) => canViewProfit || !['catalog_product', 'custom_product'].includes(tab.value)).map((tab) => (
          <Button
            key={tab.value}
            variant={groupBy === tab.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => navigate(buildUrl({ groupBy: tab.value }))}
          >
            {tab.label}
          </Button>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={exportGroupTable}
          disabled={exporting !== null || (isProductView ? productRows.length === 0 : sortedRows.length === 0)}
        >
          <Download className="h-3.5 w-3.5" />
          {exporting === 'group' ? '导出中…' : '导出表格'}
        </Button>
      </div>

      {isProductView ? (
        <ProductPerformanceTable rows={productRows} />
      ) : (
      <>
      <div className="overflow-x-auto rounded-md border">
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead>{GROUP_COLUMN_LABELS[groupBy]}</TableHead>
              <TableHead className="text-right">订单数</TableHead>
              {rate ? (
                <>
                  <TableHead className="text-right">{amountLabel}（CNY）</TableHead>
                  <TableHead className="text-right">已收（CNY）</TableHead>
                  <TableHead className="text-right">未收（CNY）</TableHead>
                </>
              ) : (
                <>
                  <TableHead className="text-right">{amountLabel}（CNY）</TableHead>
                  <TableHead className="text-right">{amountLabel}（USD）</TableHead>
                  <TableHead className="text-right">已收（CNY）</TableHead>
                  <TableHead className="text-right">已收（USD）</TableHead>
                  <TableHead className="text-right">未收（CNY）</TableHead>
                  <TableHead className="text-right">未收（USD）</TableHead>
                </>
              )}
              <TableHead className="text-right">逾期订单</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedRows.map((row) => {
              const rowOrderTotal = rate
                ? row.order_total_cny_native + row.order_total_usd * rate
                : null
              const rowReceived = rate
                ? row.received_cny_native + row.received_usd * rate
                : null
              const rowOutstanding = rate
                ? row.outstanding_cny_native + row.outstanding_usd * rate
                : null
              return (
                <TableRow key={row.group_key}>
                  <TableCell className="font-medium">{row.group_label}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {Number(row.order_count)}
                  </TableCell>
                  {rate ? (
                    <>
                      <TableCell className="text-right tabular-nums">
                        {formatCnyWhole(Number(rowOrderTotal))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-green-700">
                        {formatCnyWhole(Number(rowReceived))}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          roundWhole(Number(rowOutstanding)) !== 0 && 'text-destructive',
                        )}
                      >
                        {formatCnyWhole(Number(rowOutstanding))}
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell className="text-right tabular-nums">
                        {formatCnyWhole(Number(row.order_total_cny_native))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatUsdWhole(Number(row.order_total_usd))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-green-700">
                        {formatCnyWhole(Number(row.received_cny_native))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-green-700">
                        {formatUsdWhole(Number(row.received_usd))}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          roundWhole(Number(row.outstanding_cny)) !== 0 && 'text-destructive',
                        )}
                      >
                        {formatCnyWhole(Number(row.outstanding_cny_native))}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          roundWhole(Number(row.outstanding_cny)) !== 0 && 'text-destructive',
                        )}
                      >
                        {formatUsdWhole(Number(row.outstanding_usd))}
                      </TableCell>
                    </>
                  )}
                  <TableCell className="text-right tabular-nums">
                    {Number(row.overdue_count) > 0 ? (
                      <span className="text-destructive">{Number(row.overdue_count)}</span>
                    ) : (
                      Number(row.overdue_count)
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
            {sortedRows.length > 0 && (
              <TableRow className="border-t-2 bg-muted/40 font-semibold">
                <TableCell>合计</TableCell>
                <TableCell
                  className="text-right tabular-nums"
                  title={isItemLevelGroup ? '跨分组订单会计入多个分类，故不合计订单数' : undefined}
                >
                  {isItemLevelGroup ? '—' : groupTotals.orderCount}
                </TableCell>
                {rate ? (
                  <>
                    <TableCell className="text-right tabular-nums">
                      {formatCnyWhole(groupTotals.cnyTotal + groupTotals.usdTotal * rate)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-green-700">
                      {formatCnyWhole(groupTotals.cnyReceived + groupTotals.usdReceived * rate)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular-nums',
                        roundWhole(groupTotals.cnyOutstanding + groupTotals.usdOutstanding * rate) !== 0 &&
                          'text-destructive',
                      )}
                    >
                      {formatCnyWhole(groupTotals.cnyOutstanding + groupTotals.usdOutstanding * rate)}
                    </TableCell>
                  </>
                ) : (
                  <>
                    <TableCell className="text-right tabular-nums">
                      {formatCnyWhole(groupTotals.cnyTotal)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatUsdWhole(groupTotals.usdTotal)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-green-700">
                      {formatCnyWhole(groupTotals.cnyReceived)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-green-700">
                      {formatUsdWhole(groupTotals.usdReceived)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular-nums',
                        roundWhole(groupTotals.cnyOutstanding) !== 0 && 'text-destructive',
                      )}
                    >
                      {formatCnyWhole(groupTotals.cnyOutstanding)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular-nums',
                        roundWhole(groupTotals.usdOutstanding) !== 0 && 'text-destructive',
                      )}
                    >
                      {formatUsdWhole(groupTotals.usdOutstanding)}
                    </TableCell>
                  </>
                )}
                <TableCell className="text-right tabular-nums">
                  {isItemLevelGroup ? '—' : groupTotals.overdueCount}
                </TableCell>
              </TableRow>
            )}
            {sortedRows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={rate ? 6 : 9}
                  className="py-12 text-center text-muted-foreground"
                >
                  暂无符合条件的数据
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {isItemLevelGroup && (
        <p className="text-xs text-muted-foreground">
          {groupBy === 'shipping_category'
            ? '本表按产品明细行汇总：产品金额不含整单运费应收，也不含未填发货分类的产品行，因此合计小于上方「订单总额」。'
            : '本表按产品明细行汇总：产品金额不含整单运费应收，因此合计小于上方「订单总额」。'}
        </p>
      )}
      </>
      )}

      <div className="space-y-3 rounded-xl border bg-card p-4 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">多维销售总览</h2>
            <p className="text-sm text-muted-foreground">按最多三层维度交叉汇总销售产品行，沿用上方筛选条件。</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={exportMultiDimensionTable}
            disabled={exporting !== null || filteredMultiDimensionRows.length === 0}
          >
            <Download className="h-3.5 w-3.5" />
            {exporting === 'multi' ? '导出中…' : '导出表格'}
          </Button>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {(['第一层维度', '第二层维度', '第三层维度'] as const).map((label, index) => (
            <div key={label} className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{label}</label>
              <Select
                value={selectedDimensions[index] ?? 'none'}
                onValueChange={(value) => updateDimension(
                  index as 0 | 1 | 2,
                  value === 'none' ? null : value as BusinessPerformanceDimension,
                )}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {index > 0 && <SelectItem value="none">不分层</SelectItem>}
                  {DIMENSION_OPTIONS.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      disabled={selectedDimensions.some((dimension, position) => position !== index && dimension === option.value)}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
        <div className="overflow-x-auto rounded-md border">
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                {multiDimensionLabels.map((label, index) => (
                  <TableHead key={label} className="min-w-44">
                    <MultiSelect
                      options={multiDimensionOptions[index]}
                      value={selectedDimensionValues[index]}
                      onChange={(value) => {
                        setSelectedDimensionValues((current) => {
                          const next = [...current] as [string[], string[], string[]]
                          next[index] = value
                          return next
                        })
                      }}
                      placeholder={`全部${label}`}
                      className="h-8 bg-background px-2 text-xs"
                    />
                  </TableHead>
                ))}
                <TableHead className="text-right">订单数</TableHead>
                <TableHead className="text-right">销售数量</TableHead>
                <TableHead className="text-right">产品销售额（不含运费，CNY）</TableHead>
                <TableHead className="text-right">产品销售额（不含运费，USD）</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredMultiDimensionRows.map((row) => (
                <TableRow key={[row.dimension_1_key, row.dimension_2_key, row.dimension_3_key].join('|')}>
                  <TableCell className="font-medium">{row.dimension_1_label}</TableCell>
                  {multiDimensions[1] && <TableCell>{row.dimension_2_label}</TableCell>}
                  {multiDimensions[2] && <TableCell>{row.dimension_3_label}</TableCell>}
                  <TableCell className="text-right tabular-nums">{row.order_count.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantityWhole(row.sales_quantity)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCnyWhole(row.sales_amount_cny)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsdWhole(row.sales_amount_usd)}</TableCell>
                </TableRow>
              ))}
              {filteredMultiDimensionRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={multiDimensionLabels.length + 4} className="py-12 text-center text-muted-foreground">
                    暂无符合筛选条件的数据
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
