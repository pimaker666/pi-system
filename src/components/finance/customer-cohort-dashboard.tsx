'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type {
  BusinessPerformanceCustomerCohortRow,
  BusinessPerformanceNewCustomerFirstYearRow,
} from '@/types'

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function formatCny(value: number) {
  return Number.isFinite(value) ? `¥${numberFormat.format(Math.round(value))}` : '—'
}

function formatUsd(value: number) {
  return Number.isFinite(value) ? `$${numberFormat.format(Math.round(value))}` : '—'
}

function formatPercent(value: number | null) {
  return value === null || !Number.isFinite(value) ? '—' : `${Math.round(value * 100)}%`
}

function share(part: number, total: number) {
  return total > 0 ? part / total : null
}

function AmountCell({
  cny,
  usd,
  className,
}: {
  cny: number
  usd: number
  className?: string
}) {
  const empty = Math.round(cny) === 0 && Math.round(usd) === 0
  return (
    <div className={cn('text-right tabular-nums', className)}>
      <div>{empty ? '—' : formatCny(cny)}</div>
      {!empty && Math.round(usd) !== 0 && (
        <div className="text-xs text-muted-foreground">{formatUsd(usd)}</div>
      )}
    </div>
  )
}

function MonthStackChart({ months }: { months: BusinessPerformanceCustomerCohortRow[] }) {
  const totals = months.map(
    (row) => row.new_amount_cny_equivalent + row.old_amount_cny_equivalent + row.unbound_amount_cny_equivalent,
  )
  const max = Math.max(...totals, 1)
  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-max items-end gap-1.5 border-b pb-1">
        {months.map((row, index) => {
          const newAmount = row.new_amount_cny_equivalent
          const oldAmount = row.old_amount_cny_equivalent
          const unboundAmount = row.unbound_amount_cny_equivalent
          const total = totals[index]
          const tooltip = [
            row.period_label,
            `新客 ${row.new_customer_count} 家 / ${row.new_order_count} 单：${formatCny(row.new_amount_cny)}${row.new_amount_usd ? ` / ${formatUsd(row.new_amount_usd)}` : ''}`,
            `老客 ${row.old_customer_count} 家 / ${row.old_order_count} 单：${formatCny(row.old_amount_cny)}${row.old_amount_usd ? ` / ${formatUsd(row.old_amount_usd)}` : ''}`,
            row.unbound_order_count > 0
              ? `未绑定客户 ${row.unbound_order_count} 单：${formatCny(row.unbound_amount_cny)}${row.unbound_amount_usd ? ` / ${formatUsd(row.unbound_amount_usd)}` : ''}`
              : null,
            `合计（折算人民币）：${formatCny(total)}`,
          ]
            .filter(Boolean)
            .join('\n')
          return (
            <div key={row.period_key} className="flex w-[30px] shrink-0 flex-col items-center gap-1" title={tooltip}>
              <div className="flex h-36 w-full flex-col justify-end">
                {unboundAmount > 0 && (
                  <div
                    className="w-full bg-muted-foreground/40"
                    style={{ height: `${(unboundAmount / max) * 100}%` }}
                  />
                )}
                {oldAmount > 0 && (
                  <div
                    className="w-full bg-primary/35"
                    style={{ height: `${(oldAmount / max) * 100}%` }}
                  />
                )}
                {newAmount > 0 && (
                  <div
                    className="w-full rounded-t-sm bg-primary"
                    style={{ height: `${(newAmount / max) * 100}%` }}
                  />
                )}
                {total === 0 && <div className="h-px w-full bg-border" />}
              </div>
              <div className="text-[10px] leading-none text-muted-foreground">
                {row.period_key.slice(5)}月
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function NewCustomerFirstYearBlock({
  rows,
  window: { from, to },
  explicit,
}: {
  rows: BusinessPerformanceNewCustomerFirstYearRow[]
  window: { from: string; to: string }
  explicit: boolean
}) {
  const totals = rows.reduce(
    (acc, row) => ({
      customers: acc.customers + row.customer_count,
      firstOrders: acc.firstOrders + row.first_order_count,
      firstCny: acc.firstCny + row.first_order_amount_cny,
      firstUsd: acc.firstUsd + row.first_order_amount_usd,
      followOrders: acc.followOrders + row.follow_up_order_count,
      followCny: acc.followCny + row.follow_up_amount_cny,
      followUsd: acc.followUsd + row.follow_up_amount_usd,
      totalOrders: acc.totalOrders + row.first_year_order_count,
      totalCny: acc.totalCny + row.first_year_amount_cny,
      totalUsd: acc.totalUsd + row.first_year_amount_usd,
    }),
    {
      customers: 0,
      firstOrders: 0,
      firstCny: 0,
      firstUsd: 0,
      followOrders: 0,
      followCny: 0,
      followUsd: 0,
      totalOrders: 0,
      totalCny: 0,
      totalUsd: 0,
    },
  )

  return (
    <div className="space-y-2 rounded-lg border bg-background/60 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium">选定区间新客户 · 首年成交</h3>
        <span className="text-xs text-muted-foreground">
          首单区间 {from} ~ {to}
          {explicit ? '（按所选下单日期）' : '（未选下单日期，默认今年年初至今）'} · 首单起 12 个月内订单全计入
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">选定区间内暂无新客户首单</div>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border bg-card p-3">
              <div className="text-xs text-muted-foreground">新客户数（首单在区间内）</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {totals.customers}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  家 / 首单 {totals.firstOrders} 单
                </span>
              </div>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <div className="text-xs text-muted-foreground">首单成交额</div>
              <AmountCell cny={totals.firstCny} usd={totals.firstUsd} className="mt-1" />
            </div>
            <div className="rounded-lg border bg-card p-3">
              <div className="text-xs text-muted-foreground">一年内追加（{totals.followOrders} 单）</div>
              <AmountCell cny={totals.followCny} usd={totals.followUsd} className="mt-1" />
            </div>
            <div className="rounded-lg border bg-card p-3">
              <div className="text-xs text-muted-foreground">首年成交合计（{totals.totalOrders} 单）</div>
              <AmountCell cny={totals.totalCny} usd={totals.totalUsd} className="mt-1" />
            </div>
          </div>
          <div className="overflow-x-auto rounded-md border">
            <Table className="min-w-[680px]">
              <TableHeader>
                <TableRow>
                  <TableHead>首单月份</TableHead>
                  <TableHead className="text-right">新客数</TableHead>
                  <TableHead className="text-right">首单成交额</TableHead>
                  <TableHead className="text-right">一年内追加</TableHead>
                  <TableHead className="text-right">首年合计</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows
                  .slice()
                  .reverse()
                  .map((row) => (
                    <TableRow key={row.period_key}>
                      <TableCell className="font-medium">{row.period_key}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.customer_count}</TableCell>
                      <AmountCell
                        cny={row.first_order_amount_cny}
                        usd={row.first_order_amount_usd}
                      />
                      <TableCell
                        className="text-right"
                        title={`追加 ${row.follow_up_order_count} 单`}
                      >
                        <AmountCell cny={row.follow_up_amount_cny} usd={row.follow_up_amount_usd} />
                      </TableCell>
                      <TableCell
                        className="text-right"
                        title={`首年共 ${row.first_year_order_count} 单`}
                      >
                        <AmountCell cny={row.first_year_amount_cny} usd={row.first_year_amount_usd} />
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            口径：客户首单日期落在区间内即算新客，其首单起 12 个月内的全部订单（含首单）都计入首年成交，
            不受上方日期筛选影响；仍遵循业务/渠道/产品分组/发货分类筛选与订单可见权限，作废订单不计。
            首单成交额含首单当天全部订单。
          </p>
        </>
      )}
    </div>
  )
}

export function CustomerCohortDashboard({
  rows,
  newCustomerRows,
  newCustomerWindow,
  newCustomerWindowExplicit,
}: {
  rows: BusinessPerformanceCustomerCohortRow[]
  newCustomerRows: BusinessPerformanceNewCustomerFirstYearRow[]
  newCustomerWindow: { from: string; to: string }
  newCustomerWindowExplicit: boolean
}) {
  const [mode, setMode] = useState<'calendar' | 'rolling'>('calendar')
  const months = rows.filter((row) => row.section === 'month')
  const periods = rows
    .filter((row) => row.section === (mode === 'calendar' ? 'period_calendar' : 'period_rolling'))
    .slice()
    .reverse()
  const hasData = rows.some(
    (row) => row.new_order_count + row.old_order_count + row.unbound_order_count > 0,
  )
  const latest = periods[0] ?? null
  const unboundTotals = periods.reduce(
    (acc, row) => ({
      orders: acc.orders + row.unbound_order_count,
      cny: acc.cny + row.unbound_amount_cny,
      usd: acc.usd + row.unbound_amount_usd,
    }),
    { orders: 0, cny: 0, usd: 0 },
  )

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">新老客户成交</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            按客户首单日期区分新客/老客，成交额取订单总额（原币），沿用上方筛选条件。
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-md border p-0.5">
          <Button
            variant={mode === 'calendar' ? 'default' : 'ghost'}
            size="sm"
            className="h-7 px-3 text-xs"
            onClick={() => setMode('calendar')}
          >
            自然年
          </Button>
          <Button
            variant={mode === 'rolling' ? 'default' : 'ghost'}
            size="sm"
            className="h-7 px-3 text-xs"
            onClick={() => setMode('rolling')}
          >
            滚动 12 个月
          </Button>
        </div>
      </div>

      <NewCustomerFirstYearBlock
        rows={newCustomerRows}
        window={newCustomerWindow}
        explicit={newCustomerWindowExplicit}
      />

      {!hasData ? (
        <div className="py-10 text-center text-sm text-muted-foreground">当前筛选下暂无成交数据</div>
      ) : (
        <>
          {latest && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border bg-background p-3">
                <div className="text-xs text-muted-foreground">新客数 · {latest.period_label}</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {latest.new_customer_count}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    家 / {latest.new_order_count} 单
                  </span>
                </div>
              </div>
              <div className="rounded-lg border bg-background p-3">
                <div className="text-xs text-muted-foreground">新客成交额</div>
                <AmountCell cny={latest.new_amount_cny} usd={latest.new_amount_usd} className="mt-1" />
              </div>
              <div className="rounded-lg border bg-background p-3">
                <div className="text-xs text-muted-foreground">
                  老客成交额
                  <span className="ml-1">（{latest.old_customer_count} 家在买）</span>
                </div>
                <AmountCell cny={latest.old_amount_cny} usd={latest.old_amount_usd} className="mt-1" />
              </div>
              <div className="rounded-lg border bg-background p-3">
                <div className="text-xs text-muted-foreground">新客成交占比</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {formatPercent(
                    share(
                      latest.new_amount_cny_equivalent,
                      latest.new_amount_cny_equivalent + latest.old_amount_cny_equivalent,
                    ),
                  )}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    老客复购率 {formatPercent(share(latest.retained_customer_count, latest.prior_active_customer_count))}
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">月度成交（新客 / 老客）</h3>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-primary" />
                  新客
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-primary/35" />
                  老客
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-muted-foreground/40" />
                  未绑定客户
                </span>
              </div>
            </div>
            <MonthStackChart months={months} />
            <p className="text-xs text-muted-foreground">
              柱高按订单记账汇率折算人民币合计；悬停柱子可看当月新客/老客的单数与原币金额。
            </p>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <Table className="min-w-[560px]">
              <TableHeader>
                <TableRow>
                  <TableHead>月份</TableHead>
                  <TableHead className="text-right">新客数</TableHead>
                  <TableHead className="text-right">新客成交额</TableHead>
                  <TableHead className="text-right">老客成交额</TableHead>
                  <TableHead className="text-right">新客占比</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {months
                  .slice()
                  .reverse()
                  .map((row) => (
                    <TableRow key={row.period_key}>
                      <TableCell className="font-medium">{row.period_label}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.new_customer_count}</TableCell>
                      <AmountCell cny={row.new_amount_cny} usd={row.new_amount_usd} />
                      <AmountCell cny={row.old_amount_cny} usd={row.old_amount_usd} />
                      <TableCell className="text-right tabular-nums">
                        {formatPercent(
                          share(
                            row.new_amount_cny_equivalent,
                            row.new_amount_cny_equivalent + row.old_amount_cny_equivalent,
                          ),
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">
              {mode === 'calendar' ? '自然年新客与老客成交' : '滚动 12 个月新客与老客成交'}
            </h3>
            <div className="overflow-x-auto rounded-md border">
              <Table className="min-w-[760px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>{mode === 'calendar' ? '年度' : '滚动区间'}</TableHead>
                    <TableHead className="text-right">新客数</TableHead>
                    <TableHead className="text-right">新客成交额</TableHead>
                    <TableHead className="text-right">老客成交额</TableHead>
                    <TableHead className="text-right">新客占比</TableHead>
                    <TableHead className="text-right">
                      上期客户留存率
                      <span className="ml-1 font-normal text-muted-foreground">（复购）</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {periods.map((row) => (
                    <TableRow key={row.period_key}>
                      <TableCell className="font-medium">{row.period_label}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.new_customer_count}</TableCell>
                      <AmountCell cny={row.new_amount_cny} usd={row.new_amount_usd} />
                      <AmountCell cny={row.old_amount_cny} usd={row.old_amount_usd} />
                      <TableCell className="text-right tabular-nums">
                        {formatPercent(
                          share(
                            row.new_amount_cny_equivalent,
                            row.new_amount_cny_equivalent + row.old_amount_cny_equivalent,
                          ),
                        )}
                      </TableCell>
                      <TableCell
                        className="text-right tabular-nums"
                        title={`上期在买 ${row.prior_active_customer_count} 家，本期复购 ${row.retained_customer_count} 家；本期在买 ${row.active_customer_count} 家`}
                      >
                        {formatPercent(share(row.retained_customer_count, row.prior_active_customer_count))}
                      </TableCell>
                    </TableRow>
                  ))}
                  {periods.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                        暂无符合条件的期间数据
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            {unboundTotals.orders > 0 && (
              <p className="text-xs text-muted-foreground">
                另有未绑定客户的订单 {unboundTotals.orders} 单（{formatCny(unboundTotals.cny)}
                {Math.round(unboundTotals.usd) !== 0 ? ` / ${formatUsd(unboundTotals.usd)}` : ''}
                ），未计入新老客户分类。
              </p>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">客户年限结构（{mode === 'calendar' ? '自然年' : '滚动 12 个月'}）</h3>
            <div className="overflow-x-auto rounded-md border">
              <Table className="min-w-[640px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>{mode === 'calendar' ? '年度' : '滚动区间'}</TableHead>
                    <TableHead className="text-right">首年内（≤12 个月）</TableHead>
                    <TableHead className="text-right">1–2 年</TableHead>
                    <TableHead className="text-right">2 年以上</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {periods.map((row) => (
                    <TableRow key={row.period_key}>
                      <TableCell className="font-medium">{row.period_label}</TableCell>
                      <AmountCell cny={row.first_year_amount_cny} usd={row.first_year_amount_usd} />
                      <AmountCell cny={row.one_two_year_amount_cny} usd={row.one_two_year_amount_usd} />
                      <AmountCell cny={row.two_plus_year_amount_cny} usd={row.two_plus_year_amount_usd} />
                    </TableRow>
                  ))}
                  {periods.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                        暂无符合条件的期间数据
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              口径：新客按客户首单日期判定——首单取该客户在全部未作废、当前账号可见订单中的最早下单日期，不受上方日期筛选影响；
              成交额＝订单总额原币（CNY 为人民币订单、USD 为美元订单），作废订单不计；未绑定客户单独统计；年限按订单日期距首单日期的月数分档。
            </p>
          </div>
        </>
      )}
    </section>
  )
}
