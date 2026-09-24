'use client'

import Link from 'next/link'
import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
  BusinessPerformanceGroupBy,
  BusinessPerformanceGroupRow,
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
  { value: 'purchase', label: SHIPPING_LABELS.purchase },
]

function formatUsd(amount: number) {
  return formatCurrency(amount, 'USD')
}

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
                <TableCell className="text-right tabular-nums">{row.sales_quantity.toLocaleString()}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCny(cnySalesAmount)}</TableCell>
                {hasUnsettled && <TableCell className="text-right tabular-nums">{formatUsd(row.sales_amount_usd)}</TableCell>}
                <TableCell className="text-right tabular-nums">{formatCny(cnyAverage)}</TableCell>
                {hasUnsettled && <TableCell className="text-right tabular-nums">{formatUsd(usdAverage)}</TableCell>}
                <TableCell className="text-right tabular-nums">{formatCny(row.settled_product_cost_cny)}</TableCell>
                <TableCell className="text-right tabular-nums font-medium text-green-700">{formatCny(row.settled_product_profit_cny)}</TableCell>
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

  const rate = useMemo(() => {
    const value = Number(exchangeRate)
    return Number.isFinite(value) && value > 0 ? value : null
  }, [exchangeRate])
  const isProductView = groupBy === 'catalog_product' || groupBy === 'custom_product'

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
    if (selectedProductGroups.length > 0) {
      params.set('productGroup', selectedProductGroups.join(','))
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
    setSelectedProductGroups([])
    setSelectedShipping([])
    navigate('/finance/performance')
  }

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
      <div className="flex items-center gap-3 rounded-md border bg-card p-4">
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
          className="w-[240px]"
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
                  <div className="mt-0.5 text-sm font-medium tabular-nums">
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
                  <div className="mt-0.5 text-sm font-medium tabular-nums text-green-700">
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
                  <div className="mt-0.5 text-sm font-medium tabular-nums">
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

      <div className="flex flex-col gap-3 rounded-md border bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <div className="space-y-1.5 sm:col-span-2">
            <label className="text-xs font-medium text-muted-foreground">日期</label>
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

      <div className="flex flex-wrap gap-2">
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
      </div>

      {isProductView ? (
        <ProductPerformanceTable rows={productRows} />
      ) : (
      <div className="overflow-x-auto rounded-md border">
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead>{GROUP_COLUMN_LABELS[groupBy]}</TableHead>
              <TableHead className="text-right">订单数</TableHead>
              {rate ? (
                <>
                  <TableHead className="text-right">订单总额（CNY）</TableHead>
                  <TableHead className="text-right">已收（CNY）</TableHead>
                  <TableHead className="text-right">未收（CNY）</TableHead>
                </>
              ) : (
                <>
                  <TableHead className="text-right">订单总额（CNY）</TableHead>
                  <TableHead className="text-right">订单总额（USD）</TableHead>
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
                        {formatCny(Number(rowOrderTotal))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-green-700">
                        {formatCny(Number(rowReceived))}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          Number(rowOutstanding) > 0.005 && 'text-destructive',
                        )}
                      >
                        {formatCny(Number(rowOutstanding))}
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell className="text-right tabular-nums">
                        {formatCny(Number(row.order_total_cny_native))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatUsd(Number(row.order_total_usd))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-green-700">
                        {formatCny(Number(row.received_cny_native))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-green-700">
                        {formatUsd(Number(row.received_usd))}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          Number(row.outstanding_cny) > 0.005 && 'text-destructive',
                        )}
                      >
                        {formatCny(Number(row.outstanding_cny_native))}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          Number(row.outstanding_cny) > 0.005 && 'text-destructive',
                        )}
                      >
                        {formatUsd(Number(row.outstanding_usd))}
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
      )}
    </div>
  )
}
