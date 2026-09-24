'use client'

import { useMemo, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

type DateRange = { from: string; to: string }
type Preset = 'day' | 'week' | 'month' | 'year' | 'custom'

function dateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function chinaToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

function rangeForDate(date: Date, preset: Exclude<Preset, 'custom'>): DateRange {
  if (preset === 'day') return { from: dateKey(date), to: dateKey(date) }
  if (preset === 'week') {
    const day = date.getDay() || 7
    const from = new Date(date)
    from.setDate(date.getDate() - day + 1)
    const to = new Date(from)
    to.setDate(from.getDate() + 6)
    return { from: dateKey(from), to: dateKey(to) }
  }
  if (preset === 'month') {
    return {
      from: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`,
      to: dateKey(new Date(date.getFullYear(), date.getMonth() + 1, 0)),
    }
  }
  return { from: `${date.getFullYear()}-01-01`, to: `${date.getFullYear()}-12-31` }
}

function rangeFor(preset: Preset): DateRange | null {
  return preset === 'custom' ? null : rangeForDate(parseDate(chinaToday()), preset)
}

function monthDays(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const offset = (first.getDay() + 6) % 7
  const start = new Date(first)
  start.setDate(first.getDate() - offset)
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

function formatRange(from?: string, to?: string) {
  if (!from || !to) return '选择日期'
  if (from === to) return from
  return `${from} 至 ${to}`
}

export function DateRangePicker({
  from: initialFrom = '',
  to: initialTo = '',
  nameFrom = 'dateFrom',
  nameTo = 'dateTo',
  onChange,
  className,
}: {
  from?: string
  to?: string
  nameFrom?: string
  nameTo?: string
  onChange?: (range: { from: string; to: string }) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [range, setRange] = useState({ from: initialFrom, to: initialTo })
  const [draft, setDraft] = useState(range)
  const [viewMonth, setViewMonth] = useState(() => parseDate(initialFrom || chinaToday()))
  const [preset, setPreset] = useState<Preset>('custom')
  const months = useMemo(() => [viewMonth, new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1)], [viewMonth])

  function selectPreset(value: Preset) {
    setPreset(value)
    const next = rangeFor(value)
    if (next) setDraft(next)
  }

  function selectDay(value: string) {
    const date = parseDate(value)
    if (preset !== 'custom') {
      setDraft(rangeForDate(date, preset))
      return
    }
    if (!draft.from || draft.to) {
      setDraft({ from: value, to: '' })
      return
    }
    setDraft(value < draft.from ? { from: value, to: draft.from } : { from: draft.from, to: value })
  }

  function selectMonth(month: number) {
    setDraft(rangeForDate(new Date(viewMonth.getFullYear(), month, 1), 'month'))
  }

  function selectYear(year: number) {
    setDraft(rangeForDate(new Date(year, 0, 1), 'year'))
  }

  function apply() {
    const next = draft.from ? { from: draft.from, to: draft.to || draft.from } : { from: '', to: '' }
    setRange(next)
    onChange?.(next)
    setOpen(false)
  }

  function clear() {
    const next = { from: '', to: '' }
    setDraft(next)
    setRange(next)
    onChange?.(next)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) setDraft(range) }}>
      <input type="hidden" name={nameFrom} value={range.from} />
      <input type="hidden" name={nameTo} value={range.to} />
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className={cn('justify-start gap-2 font-normal', className)}>
          <CalendarDays className="h-4 w-4" />
          {formatRange(range.from, range.to)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(44rem,calc(100vw-2rem))] p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="flex shrink-0 gap-1 border-b p-2 sm:w-28 sm:flex-col sm:border-b-0 sm:border-r">
            {([['day', '日'], ['week', '周'], ['month', '月'], ['year', '年'], ['custom', '自定义']] as const).map(([value, label]) => (
              <Button key={value} type="button" size="sm" variant={preset === value ? 'secondary' : 'ghost'} className="justify-start" onClick={() => selectPreset(value)}>{label}</Button>
            ))}
          </div>
          <div className="min-w-0 flex-1 p-3">
            <div className="mb-3 flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - (preset === 'year' ? 12 : preset === 'month' ? 12 : 1), 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm font-medium">
                {preset === 'year' || preset === 'month' ? `${viewMonth.getFullYear()}年` : `${viewMonth.getFullYear()}年 ${viewMonth.getMonth() + 1}月`}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + (preset === 'year' ? 12 : preset === 'month' ? 12 : 1), 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            {preset === 'year' ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {Array.from({ length: 12 }, (_, index) => viewMonth.getFullYear() - 5 + index).map((year) => (
                  <Button
                    key={year}
                    type="button"
                    variant={draft.from === `${year}-01-01` && draft.to === `${year}-12-31` ? 'secondary' : 'ghost'}
                    className="h-12"
                    onClick={() => selectYear(year)}
                  >
                    {year}年
                  </Button>
                ))}
              </div>
            ) : preset === 'month' ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {Array.from({ length: 12 }, (_, month) => {
                  const from = `${viewMonth.getFullYear()}-${String(month + 1).padStart(2, '0')}-01`
                  return (
                    <Button
                      key={month}
                      type="button"
                      variant={draft.from === from ? 'secondary' : 'ghost'}
                      className="h-12"
                      onClick={() => selectMonth(month)}
                    >
                      {month + 1}月
                    </Button>
                  )
                })}
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {months.map((month) => <div key={dateKey(month)}>
                  <div className="mb-2 text-center text-sm font-medium">{month.getMonth() + 1}月</div>
                  <div className="grid grid-cols-7 text-center text-xs text-muted-foreground">{['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day} className="py-1">{day}</span>)}</div>
                  <div className="grid grid-cols-7 gap-y-1">{monthDays(month).map((day) => {
                    const value = dateKey(day)
                    const selected = value === draft.from || value === draft.to
                    const between = Boolean(draft.from && draft.to && value > draft.from && value < draft.to)
                    return <button key={value} type="button" onClick={() => selectDay(value)} className={cn('mx-auto h-8 w-8 rounded-md text-sm hover:bg-muted', day.getMonth() !== month.getMonth() && 'text-muted-foreground/40', between && 'bg-primary/10 rounded-none', selected && 'bg-primary text-primary-foreground hover:bg-primary')}>{day.getDate()}</button>
                  })}</div>
                </div>)}
              </div>
            )}
            <div className="mt-3 flex items-center justify-between border-t pt-3">
              <span className="text-xs text-muted-foreground">{formatRange(draft.from, draft.to)}</span>
              <div className="flex gap-2"><Button type="button" variant="ghost" size="sm" onClick={clear}>清空</Button><Button type="button" size="sm" onClick={apply} disabled={!draft.from}>确定</Button></div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
