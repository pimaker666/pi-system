'use client'

import { Fragment, useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowDownRight, ArrowUpRight, ChevronLeft, Download } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DateRangePicker } from '@/components/shared/date-range-picker'
import { formatCny } from '@/lib/finance'
import { journalMonthRange, journalRunningBalances, journalTotals } from '@/lib/finance-journal'
import { exportJournalOverview, type OverviewMonthStat } from '@/lib/journal-overview-export'
import { cn, displayProfileName, formatCurrency } from '@/lib/utils'
import type { FinanceJournalAccount, FinanceJournalEntry } from '@/types'

type OverviewMode = 'month' | 'quarter' | 'year' | 'ytd' | 'custom'
type MatrixDim = 'category' | 'reimbursee' | 'account'

const MODE_OPTIONS: Array<[OverviewMode, string]> = [
  ['month', '月度'],
  ['quarter', '季度'],
  ['year', '年度'],
  ['ytd', '今年'],
  ['custom', '自选'],
]

function chinaToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

function pad2(value: number) {
  return String(value).padStart(2, '0')
}

function shiftMonth(month: string, delta: number) {
  const [year, mon] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, mon - 1 + delta, 1))
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`
}

function listMonths(from: string, to: string) {
  if (!/^\d{4}-\d{2}/.test(from) || !/^\d{4}-\d{2}/.test(to)) return []
  const months: string[] = []
  let cursor = from.slice(0, 7)
  const last = to.slice(0, 7)
  while (cursor <= last) {
    months.push(cursor)
    cursor = shiftMonth(cursor, 1)
  }
  return months
}

function nextDay(date: string) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function dayBefore(date: string) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function fmtCompact(value: number) {
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${(value / 1e8).toFixed(1)}亿`
  if (abs >= 1e4) return `${(value / 1e4).toFixed(1)}万`
  return value.toFixed(0)
}

function pctChange(current: number, previous: number) {
  return previous > 0 ? (current - previous) / previous : null
}

interface TrendPoint {
  month: string
  income: number
  expense: number
  net: number
}

function TrendChart({ data }: { data: TrendPoint[] }) {
  if (data.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">暂无数据</p>
  const width = 760
  const height = 260
  const padL = 52
  const padR = 52
  const padT = 14
  const padB = 30
  const innerW = width - padL - padR
  const innerH = height - padT - padB
  const barMax = Math.max(...data.map((d) => Math.max(d.income, d.expense)), 1)
  const netMax = Math.max(...data.map((d) => Math.abs(d.net)), 1)
  const groupW = innerW / data.length
  const barW = Math.min(16, Math.max(4, groupW / 3.2))
  const yLeft = (v: number) => padT + innerH - (v / barMax) * innerH
  const yRight = (v: number) => padT + innerH - ((v + netMax) / (netMax * 2)) * innerH
  const netPoints = data.map((d, i) => `${(padL + groupW * i + groupW / 2).toFixed(1)},${yRight(d.net).toFixed(1)}`).join(' ')
  const rotate = data.length > 8
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="收支趋势图">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={padL} x2={width - padR} y1={yLeft(barMax * f)} y2={yLeft(barMax * f)} stroke="#e2e8f0" strokeWidth="1" />
          <text x={padL - 6} y={yLeft(barMax * f) + 4} textAnchor="end" fontSize="10" fill="#94a3b8">{fmtCompact(barMax * f)}</text>
          <text x={width - padR + 6} y={yLeft(barMax * f) + 4} textAnchor="start" fontSize="10" fill="#93a5c4">{fmtCompact(netMax * 2 * (1 - f) - netMax)}</text>
        </g>
      ))}
      {data.map((d, i) => {
        const cx = padL + groupW * i + groupW / 2
        return (
          <g key={d.month}>
            <rect x={cx - barW - 1} y={yLeft(d.income)} width={barW} height={Math.max(0, padT + innerH - yLeft(d.income))} fill="#10b981" rx="2" opacity="0.9" />
            <rect x={cx + 1} y={yLeft(d.expense)} width={barW} height={Math.max(0, padT + innerH - yLeft(d.expense))} fill="#f43f5e" rx="2" opacity="0.85" />
            <text
              x={cx}
              y={height - 8}
              textAnchor={rotate ? 'end' : 'middle'}
              fontSize="10"
              fill="#64748b"
              transform={rotate ? `rotate(-32 ${cx} ${height - 8})` : undefined}
            >
              {d.month.slice(0, 4) === data[0]?.month.slice(0, 4) ? d.month.slice(5) : d.month}
            </text>
          </g>
        )
      })}
      <polyline points={netPoints} fill="none" stroke="#2563eb" strokeWidth="2" />
      {data.map((d, i) => (
        <circle key={d.month} cx={padL + groupW * i + groupW / 2} cy={yRight(d.net)} r="2.5" fill="#2563eb" />
      ))}
    </svg>
  )
}

interface BalancePoint {
  label: string
  value: number
}

function BalanceChart({ data, moneyLabel }: { data: BalancePoint[]; moneyLabel: string }) {
  if (data.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">暂无数据</p>
  const width = 760
  const height = 240
  const padL = 60
  const padR = 16
  const padT = 16
  const padB = 28
  const innerW = width - padL - padR
  const innerH = height - padT - padB
  const values = data.map((d) => d.value)
  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  const span = Math.max(rawMax - rawMin, 1)
  const min = rawMin - span * 0.12
  const max = rawMax + span * 0.12
  const x = (i: number) => padL + (data.length === 1 ? innerW / 2 : (innerW * i) / (data.length - 1))
  const y = (v: number) => padT + innerH - ((v - min) / (max - min)) * innerH
  const points = data.map((d, i) => `${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ')
  const area = `${padL},${padT + innerH} ${points} ${x(data.length - 1).toFixed(1)},${padT + innerH}`
  const peak = values.reduce((best, v, i) => (v > values[best] ? i : best), 0)
  const valley = values.reduce((best, v, i) => (v < values[best] ? i : best), 0)
  const labelEvery = Math.ceil(data.length / 10)
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="余额走势图">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={padL} x2={width - padR} y1={padT + innerH * f} y2={padT + innerH * f} stroke="#e2e8f0" />
          <text x={padL - 6} y={padT + innerH * f + 4} textAnchor="end" fontSize="10" fill="#94a3b8">{fmtCompact(max - (max - min) * f)}</text>
        </g>
      ))}
      <polygon points={area} fill="#2563eb" opacity="0.08" />
      <polyline points={points} fill="none" stroke="#2563eb" strokeWidth="2" />
      {[peak, valley].map((index) => (
        <g key={index}>
          <circle cx={x(index)} cy={y(values[index])} r="3" fill="#2563eb" />
          <text x={x(index)} y={y(values[index]) - 8} textAnchor="middle" fontSize="10" fill="#2563eb">
            {`${data[index].label.length > 7 ? data[index].label.slice(5) : data[index].label} ${fmtCompact(values[index])}`}
          </text>
        </g>
      ))}
      {data.map((d, i) => (
        labelEvery > 1 && i % labelEvery !== 0 && i !== data.length - 1 ? null : (
          <text key={d.label} x={x(i)} y={height - 8} textAnchor="middle" fontSize="10" fill="#64748b">
            {data.length > 14 ? d.label.slice(5) : d.label}
          </text>
        )
      ))}
      <text x={width - padR} y={padT - 4} textAnchor="end" fontSize="10" fill="#94a3b8">{moneyLabel}</text>
    </svg>
  )
}

export function JournalOverview({
  entries,
  accounts,
}: {
  entries: FinanceJournalEntry[]
  accounts: FinanceJournalAccount[]
}) {
  const today = useMemo(chinaToday, [])
  const currentYear = Number(today.slice(0, 4))

  const [mode, setMode] = useState<OverviewMode>('month')
  const [monthValue, setMonthValue] = useState(today.slice(0, 7))
  const [yearValue, setYearValue] = useState(currentYear)
  const [quarter, setQuarter] = useState(Math.ceil(Number(today.slice(5, 7)) / 3))
  const [customRange, setCustomRange] = useState<{ from: string; to: string }>({
    from: `${shiftMonth(today.slice(0, 7), -2)}-01`,
    to: today,
  })
  const [accountId, setAccountId] = useState('all')
  const [trendView, setTrendView] = useState<'chart' | 'table'>('chart')
  const [matrixDim, setMatrixDim] = useState<MatrixDim>('category')
  const [drillId, setDrillId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const range = useMemo(() => {
    if (mode === 'month') return journalMonthRange(monthValue) ?? { from: `${today.slice(0, 7)}-01`, to: today }
    if (mode === 'quarter') {
      return {
        from: `${yearValue}-${pad2((quarter - 1) * 3 + 1)}-01`,
        to: journalMonthRange(`${yearValue}-${pad2(quarter * 3)}`)?.to ?? today,
      }
    }
    if (mode === 'year') return { from: `${yearValue}-01-01`, to: `${yearValue}-12-31` }
    if (mode === 'ytd') return { from: `${currentYear}-01-01`, to: today }
    return customRange
  }, [mode, monthValue, yearValue, quarter, customRange, today, currentYear])

  const customError = useMemo(() => {
    if (mode !== 'custom') return ''
    if (!range.from || !range.to) return '请选择完整的起止日期'
    if (range.from > range.to) return '开始日期不能晚于结束日期'
    if (listMonths(range.from, range.to).length > 24) return '自选区间最长 24 个月'
    return ''
  }, [mode, range])

  const accountScoped = useMemo(
    () => entries.filter((row) => !row.voided_at && (accountId === 'all' || row.account_id === accountId)),
    [entries, accountId],
  )

  const scoped = useMemo(
    () => accountScoped.filter((row) => row.entry_date >= range.from && row.entry_date <= range.to),
    [accountScoped, range],
  )

  const totals = useMemo(() => journalTotals(scoped), [scoped])

  const trendMonths = useMemo(
    () => (mode === 'month'
      ? Array.from({ length: 6 }, (_, i) => shiftMonth(monthValue, i - 5))
      : listMonths(range.from, range.to)),
    [mode, monthValue, range],
  )

  const trendData: TrendPoint[] = useMemo(() => {
    const byMonth = new Map<string, TrendPoint>()
    for (const month of trendMonths) byMonth.set(month, { month, income: 0, expense: 0, net: 0 })
    for (const row of accountScoped) {
      const point = byMonth.get(row.entry_date.slice(0, 7))
      if (!point) continue
      if (row.kind === 'income') point.income += Number(row.amount_cny)
      else point.expense += Number(row.amount_cny)
    }
    return [...byMonth.values()].map((point) => ({ ...point, net: point.income - point.expense }))
  }, [accountScoped, trendMonths])

  const prevTotals = useMemo(() => {
    let prev: { from: string; to: string } | null = null
    if (mode === 'month') prev = journalMonthRange(shiftMonth(monthValue, -1))
    else if (mode === 'quarter') {
      const year = quarter === 1 ? yearValue - 1 : yearValue
      const q = quarter === 1 ? 4 : quarter - 1
      prev = { from: `${year}-${pad2((q - 1) * 3 + 1)}-01`, to: journalMonthRange(`${year}-${pad2(q * 3)}`)?.to ?? today }
    } else if (mode === 'year') prev = { from: `${yearValue - 1}-01-01`, to: `${yearValue - 1}-12-31` }
    else if (mode === 'ytd') prev = { from: `${currentYear - 1}-01-01`, to: `${currentYear - 1}${today.slice(4)}` }
    else {
      const count = listMonths(range.from, range.to).length
      const to = dayBefore(range.from)
      prev = { from: `${shiftMonth(to.slice(0, 7), -(count - 1))}-01`, to }
    }
    if (!prev) return null
    return journalTotals(accountScoped.filter((row) => row.entry_date >= prev.from && row.entry_date <= prev.to))
  }, [mode, monthValue, yearValue, quarter, range, today, currentYear, accountScoped])

  const currencyRate = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of entries) {
      if (row.voided_at || map.has(row.currency)) continue
      map.set(row.currency, Number(row.exchange_rate_to_cny))
    }
    map.set('CNY', 1)
    return map
  }, [entries])

  const accountsInScope = useMemo(
    () => accounts.filter((account) => accountId === 'all' || account.id === accountId),
    [accounts, accountId],
  )

  const { opening, closing } = useMemo(() => {
    if (!range.from || !range.to || range.from > range.to) return { opening: 0, closing: 0 }
    const balanceAt = (upto: string) => {
      let sum = 0
      for (const account of accountsInScope) {
        let balance = Number(account.initial_balance)
        for (const row of entries) {
          if (row.voided_at || row.account_id !== account.id || row.entry_date > upto) continue
          balance += row.kind === 'income' ? Number(row.amount_original) : -Number(row.amount_original)
        }
        sum += balance * (currencyRate.get(account.currency) ?? 1)
      }
      return sum
    }
    return { opening: balanceAt(dayBefore(range.from)), closing: balanceAt(range.to) }
  }, [accountsInScope, entries, currencyRate, range])

  const balanceSeries = useMemo<BalancePoint[]>(() => {
    if (!range.from || !range.to || range.from > range.to) return []
    if (mode === 'month') {
      const running = new Map<string, number>()
      for (const account of accountsInScope) {
        let balance = Number(account.initial_balance)
        for (const row of entries) {
          if (row.voided_at || row.account_id !== account.id || row.entry_date >= range.from) continue
          balance += row.kind === 'income' ? Number(row.amount_original) : -Number(row.amount_original)
        }
        running.set(account.id, balance)
      }
      const flows = new Map<string, number>()
      for (const row of accountScoped) {
        if (row.entry_date < range.from || row.entry_date > range.to) continue
        const key = `${row.account_id}|${row.entry_date}`
        flows.set(key, (flows.get(key) ?? 0) + (row.kind === 'income' ? Number(row.amount_original) : -Number(row.amount_original)))
      }
      const points: BalancePoint[] = []
      let cursor = range.from
      while (cursor <= range.to) {
        let sum = 0
        for (const account of accountsInScope) {
          const next = (running.get(account.id) ?? 0) + (flows.get(`${account.id}|${cursor}`) ?? 0)
          running.set(account.id, next)
          sum += next * (currencyRate.get(account.currency) ?? 1)
        }
        points.push({ label: cursor, value: sum })
        cursor = nextDay(cursor)
      }
      return points
    }
    return trendMonths.map((month) => {
      const end = journalMonthRange(month)?.to ?? month
      let sum = 0
      for (const account of accountsInScope) {
        let balance = Number(account.initial_balance)
        for (const row of entries) {
          if (row.voided_at || row.account_id !== account.id || row.entry_date > end) continue
          balance += row.kind === 'income' ? Number(row.amount_original) : -Number(row.amount_original)
        }
        sum += balance * (currencyRate.get(account.currency) ?? 1)
      }
      return { label: month, value: sum }
    })
  }, [mode, accountsInScope, entries, accountScoped, currencyRate, range, trendMonths])

  const topExpenses = useMemo(() => {
    const rows = scoped
      .filter((row) => row.kind === 'expense')
      .sort((a, b) => Number(b.amount_cny) - Number(a.amount_cny))
      .slice(0, 5)
    return rows.map((row) => ({
      row,
      amount: Number(row.amount_cny),
      share: totals.expense > 0 ? Number(row.amount_cny) / totals.expense : 0,
    }))
  }, [scoped, totals.expense])

  const kindBreakdown = useCallback((kind: 'income' | 'expense') => {
    const sums = new Map<string, number>()
    let total = 0
    for (const row of scoped) {
      if (row.kind !== kind) continue
      const name = row.category?.name ?? '未分类'
      sums.set(name, (sums.get(name) ?? 0) + Number(row.amount_cny))
      total += Number(row.amount_cny)
    }
    return [...sums.entries()]
      .map(([name, amount]) => ({ name, amount, share: total > 0 ? amount / total : 0 }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10)
  }, [scoped])
  const expenseBreakdown = useMemo(() => kindBreakdown('expense'), [kindBreakdown])
  const incomeBreakdown = useMemo(() => kindBreakdown('income'), [kindBreakdown])

  const accountRows = useMemo(() => accountsInScope
    .map((account) => {
      let incomeOriginal = 0
      let expenseOriginal = 0
      let incomeCny = 0
      let expenseCny = 0
      for (const row of scoped) {
        if (row.account_id !== account.id) continue
        if (row.kind === 'income') {
          incomeOriginal += Number(row.amount_original)
          incomeCny += Number(row.amount_cny)
        } else {
          expenseOriginal += Number(row.amount_original)
          expenseCny += Number(row.amount_cny)
        }
      }
      return { account, incomeOriginal, expenseOriginal, incomeCny, expenseCny }
    })
    .filter((row) => row.incomeOriginal > 0 || row.expenseOriginal > 0), [accountsInScope, scoped])

  const reimburseeRows = useMemo(() => {
    const sums = new Map<string, number>()
    for (const row of scoped) {
      if (row.kind !== 'expense' || !row.reimbursee) continue
      sums.set(row.reimbursee, (sums.get(row.reimbursee) ?? 0) + Number(row.amount_cny))
    }
    return [...sums.entries()]
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount)
  }, [scoped])

  const matrix = useMemo(() => {
    const keyOf = (row: FinanceJournalEntry) =>
      matrixDim === 'category'
        ? (row.category?.name ?? '未分类')
        : matrixDim === 'reimbursee'
          ? (row.reimbursee ?? '未填写')
          : (row.account?.name ?? '未填写')
    const monthSet = new Set(trendMonths)
    const cellMap = new Map<string, number>()
    const rowSet = new Set<string>()
    for (const row of accountScoped) {
      const month = row.entry_date.slice(0, 7)
      if (!monthSet.has(month)) continue
      const key = keyOf(row)
      rowSet.add(key)
      cellMap.set(`${key}|${month}`, (cellMap.get(`${key}|${month}`) ?? 0) + Number(row.amount_cny))
    }
    const cell = (key: string, month: string) => cellMap.get(`${key}|${month}`) ?? 0
    const totalOf = (key: string) => trendMonths.reduce((sum, month) => sum + cell(key, month), 0)
    return {
      rows: [...rowSet].sort((a, b) => totalOf(b) - totalOf(a)),
      cell,
      totalOf,
    }
  }, [accountScoped, trendMonths, matrixDim])

  const accountLabel = accountId === 'all'
    ? '全部账户'
    : accounts.find((account) => account.id === accountId)?.name ?? accountId

  const scopeLabel = mode === 'month'
    ? monthValue
    : mode === 'quarter'
      ? `${yearValue}Q${quarter}`
      : mode === 'year'
        ? `${yearValue}年`
        : mode === 'ytd'
          ? `${currentYear}年至今`
          : `${range.from}至${range.to}`

  const runningBalances = useMemo(
    () => journalRunningBalances(accounts, [...entries].reverse()),
    [accounts, entries],
  )

  function trendBadge(current: number, previous: number, upIsGood: boolean) {
    const change = prevTotals ? pctChange(current, previous) : null
    if (change === null) return <span className="text-xs text-muted-foreground">较上期 —</span>
    const good = upIsGood ? change >= 0 : change < 0
    const Icon = change >= 0 ? ArrowUpRight : ArrowDownRight
    return (
      <span className={cn('inline-flex items-center gap-0.5 text-xs font-medium', good ? 'text-emerald-600' : 'text-destructive')}>
        <Icon className="h-3.5 w-3.5" />
        {(Math.abs(change) * 100).toFixed(1)}%
        <span className="font-normal text-muted-foreground">较上期</span>
      </span>
    )
  }

  async function handleExport() {
    if (customError) {
      toast.error(customError)
      return
    }
    setExporting(true)
    try {
      const monthsInRange = listMonths(range.from, range.to)
      const monthStats: OverviewMonthStat[] = monthsInRange.map((month) => {
        const point = trendMonths.includes(month)
          ? trendData.find((d) => d.month === month)
          : undefined
        if (point) return { month, income: point.income, expense: point.expense, net: point.net }
        let income = 0
        let expense = 0
        for (const row of accountScoped) {
          if (row.entry_date.slice(0, 7) !== month) continue
          if (row.kind === 'income') income += Number(row.amount_cny)
          else expense += Number(row.amount_cny)
        }
        return { month, income, expense, net: income - expense }
      })
      const entriesByMonth = new Map<string, FinanceJournalEntry[]>()
      for (const month of monthsInRange) {
        const rows = entries
          .filter((row) =>
            (accountId === 'all' || row.account_id === accountId) &&
            row.entry_date.slice(0, 7) === month)
          .sort((a, b) =>
            a.entry_date.localeCompare(b.entry_date) ||
            a.created_at.localeCompare(b.created_at) ||
            a.id.localeCompare(b.id))
        entriesByMonth.set(month, rows)
      }
      const categorySums = new Map<string, { name: string; kind: 'income' | 'expense'; amount: number }>()
      for (const row of scoped) {
        const key = `${row.kind}|${row.category?.name ?? '未分类'}`
        const item = categorySums.get(key) ?? { name: row.category?.name ?? '未分类', kind: row.kind, amount: 0 }
        item.amount += Number(row.amount_cny)
        categorySums.set(key, item)
      }
      const categories = [...categorySums.values()].sort((a, b) => b.amount - a.amount)
      const voidedInRange = entries.filter((row) =>
        row.voided_at &&
        (accountId === 'all' || row.account_id === accountId) &&
        row.entry_date >= range.from && row.entry_date <= range.to).length
      await exportJournalOverview({
        scopeLabel,
        accountLabel,
        from: range.from,
        to: range.to,
        months: monthStats,
        totals: { ...totals, voided: voidedInRange },
        openingBalanceCny: opening,
        closingBalanceCny: closing,
        categories,
        accounts: accountRows.map((row) => ({
          name: row.account.name,
          currency: row.account.currency,
          incomeOriginal: row.incomeOriginal,
          expenseOriginal: row.expenseOriginal,
          incomeCny: row.incomeCny,
          expenseCny: row.expenseCny,
        })),
        reimbursees: reimburseeRows,
        runningBalances,
        entriesByMonth,
      })
      toast.success('总览已导出')
    } catch {
      toast.error('导出失败，请重试')
    } finally {
      setExporting(false)
    }
  }

  const periodControl = mode === 'month' ? (
    <Input
      type="month"
      value={monthValue}
      onChange={(event) => setMonthValue(event.target.value || today.slice(0, 7))}
      aria-label="选择月份"
      className="w-40"
    />
  ) : mode === 'quarter' ? (
    <>
      <Select value={String(yearValue)} onValueChange={(value) => setYearValue(Number(value))}>
        <SelectTrigger aria-label="选择年份" className="w-28"><SelectValue /></SelectTrigger>
        <SelectContent>
          {Array.from({ length: 11 }, (_, i) => currentYear - 5 + i).map((year) => (
            <SelectItem key={year} value={String(year)}>{year}年</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={String(quarter)} onValueChange={(value) => setQuarter(Number(value))}>
        <SelectTrigger aria-label="选择季度" className="w-28"><SelectValue /></SelectTrigger>
        <SelectContent>
          {[1, 2, 3, 4].map((q) => <SelectItem key={q} value={String(q)}>第{q}季度</SelectItem>)}
        </SelectContent>
      </Select>
    </>
  ) : mode === 'year' ? (
    <Select value={String(yearValue)} onValueChange={(value) => setYearValue(Number(value))}>
      <SelectTrigger aria-label="选择年份" className="w-32"><SelectValue /></SelectTrigger>
      <SelectContent>
        {Array.from({ length: 11 }, (_, i) => currentYear - 5 + i).map((year) => (
          <SelectItem key={year} value={String(year)}>{year}年</SelectItem>
        ))}
      </SelectContent>
    </Select>
  ) : mode === 'ytd' ? (
    <span className="rounded-md border bg-muted px-3 py-2 text-sm">{currentYear}-01-01 至 {today}</span>
  ) : (
    <DateRangePicker
      from={customRange.from}
      to={customRange.to}
      onChange={(next) => setCustomRange(next)}
      className="w-72"
    />
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">日记账总览</h1>
          <p className="text-sm text-muted-foreground">
            按月度 / 季度 / 年度 / 今年 / 自选区间查看收支趋势、余额与构成，支持导出 Excel（总览 + 每月明细）。
          </p>
        </div>
        <Button variant="ghost" asChild>
          <Link href="/finance/journal"><ChevronLeft className="h-4 w-4" />返回日记账</Link>
        </Button>
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label="统计区间">
            {MODE_OPTIONS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                onClick={() => setMode(value)}
                className={cn(
                  'rounded px-3 py-1.5 text-sm transition-colors',
                  mode === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {periodControl}
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger aria-label="筛选账户" className="w-48"><SelectValue placeholder="账户" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部账户</SelectItem>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={handleExport} disabled={exporting || Boolean(customError)} className="ml-auto">
            <Download className="h-4 w-4" />
            {exporting ? '正在导出…' : '导出总览 Excel'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          统计范围 {range.from || '—'} 至 {range.to || '—'} · 账户 {accountLabel} · 排除作废 · 金额折 CNY；余额按各币种最近流水汇率折算估算。
        </p>
        {customError && <p role="alert" className="text-sm text-destructive">{customError}</p>}
      </div>

      {scoped.length === 0 ? (
        <div role="alert" className="rounded-lg border p-6 text-sm text-muted-foreground">
          所选范围内暂无日记账记录，可切换区间或账户后重试。
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {([
              {
                label: '收入合计',
                value: formatCny(totals.income),
                cls: 'text-emerald-600',
                badge: trendBadge(totals.income, prevTotals?.income ?? 0, true),
              },
              {
                label: '支出合计',
                value: formatCny(totals.expense),
                cls: 'text-destructive',
                badge: trendBadge(totals.expense, prevTotals?.expense ?? 0, false),
              },
              {
                label: '净收支',
                value: formatCny(totals.net),
                cls: totals.net >= 0 ? 'text-emerald-600' : 'text-destructive',
                badge: <span className="text-xs text-muted-foreground">{totals.normal} 条正常流水</span>,
              },
              {
                label: '期末余额（折CNY 估算）',
                value: formatCny(closing),
                cls: '',
                badge: <span className="text-xs text-muted-foreground">期初 {formatCny(opening)}</span>,
              },
            ] as const).map((kpi) => (
              <div key={kpi.label} className="rounded-lg border bg-card p-4">
                <div className="text-xs text-muted-foreground">{kpi.label}</div>
                <div className={cn('mt-1 text-2xl font-semibold', kpi.cls)}>{kpi.value}</div>
                <div className="mt-1">{kpi.badge}</div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">收支趋势</h2>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500" />收入
                  <span className="ml-2 inline-block h-2.5 w-2.5 rounded-sm bg-rose-500" />支出
                  <span className="ml-2 inline-block h-0.5 w-4 bg-blue-600" />净额
                </span>
                <div className="inline-flex rounded-md border p-0.5">
                  {([['chart', '图表'], ['table', '表格']] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setTrendView(value)}
                      aria-pressed={trendView === value}
                      className={cn(
                        'rounded px-2.5 py-1 text-xs',
                        trendView === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {trendView === 'chart' ? (
              <TrendChart data={trendData} />
            ) : (
              <div className="overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>月份</TableHead>
                      <TableHead className="text-right">收入（CNY）</TableHead>
                      <TableHead className="text-right">支出（CNY）</TableHead>
                      <TableHead className="text-right">净额（CNY）</TableHead>
                      <TableHead className="text-right">收入环比</TableHead>
                      <TableHead className="text-right">支出环比</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trendData.map((point, index) => {
                      const prevPoint = index > 0 ? trendData[index - 1] : null
                      const incomeChange = prevPoint ? pctChange(point.income, prevPoint.income) : null
                      const expenseChange = prevPoint ? pctChange(point.expense, prevPoint.expense) : null
                      return (
                        <TableRow key={point.month}>
                          <TableCell className="font-medium">{point.month}</TableCell>
                          <TableCell className="text-right text-sm text-emerald-600">{formatCny(point.income)}</TableCell>
                          <TableCell className="text-right text-sm text-destructive">{formatCny(point.expense)}</TableCell>
                          <TableCell className={cn('text-right text-sm', point.net >= 0 ? 'text-emerald-600' : 'text-destructive')}>
                            {formatCny(point.net)}
                          </TableCell>
                          <TableCell className="text-right text-sm text-muted-foreground">
                            {incomeChange === null ? '—' : `${(incomeChange * 100).toFixed(1)}%`}
                          </TableCell>
                          <TableCell className="text-right text-sm text-muted-foreground">
                            {expenseChange === null ? '—' : `${(expenseChange * 100).toFixed(1)}%`}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">{mode === 'month' ? '日度余额走势（折CNY 估算）' : '月末余额走势（折CNY 估算）'}</h2>
            <BalanceChart data={balanceSeries} moneyLabel="CNY" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">TOP5 大额支出</h2>
              {topExpenses.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">所选范围内暂无支出记录</p>
              ) : (
                <div className="overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>日期</TableHead>
                        <TableHead>摘要</TableHead>
                        <TableHead>分类</TableHead>
                        <TableHead className="text-right">金额（CNY）</TableHead>
                        <TableHead className="text-right">占比</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {topExpenses.map(({ row, amount, share }) => (
                        <Fragment key={row.id}>
                          <TableRow
                            className="cursor-pointer"
                            onClick={() => setDrillId(drillId === row.id ? null : row.id)}
                          >
                            <TableCell className="text-sm">{row.entry_date}</TableCell>
                            <TableCell className="max-w-48 truncate text-sm">{row.summary}</TableCell>
                            <TableCell className="text-sm">{row.category?.name ?? '未分类'}</TableCell>
                            <TableCell className="text-right text-sm text-destructive">{formatCny(amount)}</TableCell>
                            <TableCell className="text-right text-sm text-muted-foreground">{(share * 100).toFixed(1)}%</TableCell>
                          </TableRow>
                          {drillId === row.id && (
                            <TableRow>
                              <TableCell colSpan={5} className="bg-muted/40 text-sm">
                                <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                                  <span>账户：{row.account?.name ?? '—'}</span>
                                  <span>收/付款人：{row.counterparty ?? '—'}</span>
                                  <span>原币金额：{formatCurrency(Number(row.amount_original), row.currency)}</span>
                                  <span>汇率：{Number(row.exchange_rate_to_cny)}</span>
                                  <span>流水号：{row.reference_no ?? '—'}</span>
                                  <span>店铺：{row.shop ?? '—'}</span>
                                  <span>报销人：{row.reimbursee ?? '—'}</span>
                                  <span>登记人：{displayProfileName(row.creator)}</span>
                                  {row.remark && <span className="sm:col-span-2">备注：{row.remark}</span>}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>

            <div className="rounded-lg border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">报销人支出</h2>
              {reimburseeRows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">所选范围内暂无报销支出</p>
              ) : (
                <div className="overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>报销人</TableHead>
                        <TableHead className="text-right">支出（CNY）</TableHead>
                        <TableHead className="text-right">占总支出</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {reimburseeRows.map((item) => (
                        <TableRow key={item.name}>
                          <TableCell className="text-sm font-medium">{item.name}</TableCell>
                          <TableCell className="text-right text-sm text-destructive">{formatCny(item.amount)}</TableCell>
                          <TableCell className="text-right text-sm text-muted-foreground">
                            {totals.expense > 0 ? `${((item.amount / totals.expense) * 100).toFixed(1)}%` : '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {([
              { title: '支出构成 TOP10', items: expenseBreakdown, barClass: 'bg-rose-500' },
              { title: '收入构成 TOP10', items: incomeBreakdown, barClass: 'bg-emerald-500' },
            ] as const).map((block) => (
              <div key={block.title} className="rounded-lg border bg-card p-4">
                <h2 className="mb-3 text-sm font-semibold">{block.title}</h2>
                {block.items.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">暂无记录</p>
                ) : (
                  <ul className="space-y-2">
                    {block.items.map((item) => (
                      <li key={item.name} className="flex items-center gap-3 text-sm">
                        <span className="w-28 truncate" title={item.name}>{item.name}</span>
                        <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                          <span
                            className={cn('block h-full rounded-full', block.barClass)}
                            style={{ width: `${Math.max(2, item.share * 100)}%` }}
                          />
                        </span>
                        <span className="w-24 text-right">{formatCny(item.amount)}</span>
                        <span className="w-12 text-right text-xs text-muted-foreground">{(item.share * 100).toFixed(1)}%</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>

          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">账户收支</h2>
            {accountRows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">所选范围内账户暂无收支记录</p>
            ) : (
              <div className="overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>账户</TableHead>
                      <TableHead>币种</TableHead>
                      <TableHead className="text-right">收入（原币）</TableHead>
                      <TableHead className="text-right">支出（原币）</TableHead>
                      <TableHead className="text-right">净额（原币）</TableHead>
                      <TableHead className="text-right">收入（CNY）</TableHead>
                      <TableHead className="text-right">支出（CNY）</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accountRows.map((row) => (
                      <TableRow key={row.account.id}>
                        <TableCell className="text-sm font-medium">{row.account.name}</TableCell>
                        <TableCell className="text-sm">{row.account.currency}</TableCell>
                        <TableCell className="text-right text-sm text-emerald-600">
                          {formatCurrency(row.incomeOriginal, row.account.currency)}
                        </TableCell>
                        <TableCell className="text-right text-sm text-destructive">
                          {formatCurrency(row.expenseOriginal, row.account.currency)}
                        </TableCell>
                        <TableCell className={cn('text-right text-sm', row.incomeOriginal - row.expenseOriginal >= 0 ? 'text-emerald-600' : 'text-destructive')}>
                          {formatCurrency(row.incomeOriginal - row.expenseOriginal, row.account.currency)}
                        </TableCell>
                        <TableCell className="text-right text-sm text-emerald-600">{formatCny(row.incomeCny)}</TableCell>
                        <TableCell className="text-right text-sm text-destructive">{formatCny(row.expenseCny)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="border-t-2 font-medium">
                      <TableCell className="text-sm">合计</TableCell>
                      <TableCell className="text-sm">—</TableCell>
                      <TableCell className="text-sm" colSpan={3}>原币不跨币种相加</TableCell>
                      <TableCell className="text-right text-sm text-emerald-600">{formatCny(accountRows.reduce((sum, row) => sum + row.incomeCny, 0))}</TableCell>
                      <TableCell className="text-right text-sm text-destructive">{formatCny(accountRows.reduce((sum, row) => sum + row.expenseCny, 0))}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          <div className="rounded-lg border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">
                {matrixDim === 'category' ? '分类' : matrixDim === 'reimbursee' ? '报销人' : '账户'} × 月份矩阵（折CNY，排除作废）
              </h2>
              <Select value={matrixDim} onValueChange={(value) => setMatrixDim(value as MatrixDim)}>
                <SelectTrigger aria-label="汇总维度" className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="category">按分类</SelectItem>
                  <SelectItem value="reimbursee">按报销人</SelectItem>
                  <SelectItem value="account">按账户</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {matrix.rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">所选范围内暂无记录</p>
            ) : (
              <div className="max-h-96 overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="sticky left-0 bg-muted">
                        {matrixDim === 'category' ? '分类' : matrixDim === 'reimbursee' ? '报销人' : '账户'}
                      </TableHead>
                      {trendMonths.map((month) => (
                        <TableHead key={month} className="text-right">{month}</TableHead>
                      ))}
                      <TableHead className="text-right">合计</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {matrix.rows.map((rowKey) => (
                      <TableRow key={rowKey}>
                        <TableCell className="sticky left-0 bg-card font-medium">{rowKey}</TableCell>
                        {trendMonths.map((month) => (
                          <TableCell key={month} className="text-right text-sm">
                            {matrix.cell(rowKey, month) > 0 ? formatCny(matrix.cell(rowKey, month)) : '—'}
                          </TableCell>
                        ))}
                        <TableCell className="text-right text-sm font-medium">{formatCny(matrix.totalOf(rowKey))}</TableCell>
                      </TableRow>
                    ))}
                    {([
                      { label: '收入合计', pick: (month: string) => trendData.find((d) => d.month === month)?.income ?? 0, cls: 'text-emerald-600' },
                      { label: '支出合计', pick: (month: string) => trendData.find((d) => d.month === month)?.expense ?? 0, cls: 'text-destructive' },
                    ] as const).map(({ label, pick, cls }) => (
                      <TableRow key={label} className="border-t-2 font-medium">
                        <TableCell className="sticky left-0 bg-card">{label}</TableCell>
                        {trendMonths.map((month) => (
                          <TableCell key={month} className={cn('text-right text-sm', cls)}>{formatCny(pick(month))}</TableCell>
                        ))}
                        <TableCell className={cn('text-right text-sm', cls)}>
                          {formatCny(trendMonths.reduce((sum, month) => sum + pick(month), 0))}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-medium">
                      <TableCell className="sticky left-0 bg-card">月度净额</TableCell>
                      {trendMonths.map((month) => {
                        const point = trendData.find((d) => d.month === month)
                        const net = point?.net ?? 0
                        return (
                          <TableCell key={month} className={cn('text-right text-sm', net >= 0 ? 'text-emerald-600' : 'text-destructive')}>
                            {formatCny(net)}
                          </TableCell>
                        )
                      })}
                      <TableCell className="text-right text-sm">{formatCny(trendData.reduce((sum, point) => sum + point.net, 0))}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
