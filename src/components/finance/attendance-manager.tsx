'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import {
  createAttendanceSheet,
  deleteAttendanceSheet,
  updateAttendanceSheetNote,
  upsertAttendanceEntry,
} from '@/lib/actions/attendance'
import { ATTENDANCE_SYMBOLS, summarizeAttendance } from '@/lib/attendance'
import { displayProfileName } from '@/lib/utils'
import type { AttendanceEntry, AttendanceSheet, Profile } from '@/types'

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

const CELL_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '·' },
  ...ATTENDANCE_SYMBOLS.map(({ symbol, label }) => ({ value: symbol, label: `${symbol} ${label}` })),
]

function monthLabel(month: string) {
  return `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`
}

function daysInMonth(month: string) {
  const year = Number(month.slice(0, 4))
  const monthIndex = Number(month.slice(5, 7))
  return new Date(year, monthIndex, 0).getDate()
}

function entryKey(profileId: string, day: number) {
  return `${profileId}:${day}`
}

export function AttendanceManager({
  canManage,
  sheets,
  profiles,
  entries,
  selectedMonth,
  selectedSheetId,
  initialNote,
}: {
  canManage: boolean
  sheets: AttendanceSheet[]
  profiles: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'>[]
  entries: AttendanceEntry[]
  selectedMonth: string
  selectedSheetId: string
  initialNote: string
}) {
  const router = useRouter()
  const [currentMonth, setCurrentMonth] = useState(selectedMonth)
  const [grid, setGrid] = useState<Record<string, { morning: string; afternoon: string }>>({})
  const [note, setNote] = useState(initialNote)
  const [pending, startTransition] = useTransition()
  const [createOpen, setCreateOpen] = useState(false)
  const [createMonth, setCreateMonth] = useState('')
  const [createNote, setCreateNote] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)

  useEffect(() => {
    setCurrentMonth(selectedMonth)
  }, [selectedMonth])

  useEffect(() => {
    const next: Record<string, { morning: string; afternoon: string }> = {}
    for (const entry of entries) {
      next[entryKey(entry.profile_id, entry.day)] = {
        morning: entry.morning,
        afternoon: entry.afternoon,
      }
    }
    setGrid(next)
    setNote(initialNote)
  }, [entries, initialNote])

  const sheet = sheets.find((entry) => entry.month === currentMonth) ?? null
  const days = sheet ? daysInMonth(sheet.month) : 0
  const dayNumbers = useMemo(() => Array.from({ length: days }, (_, i) => i + 1), [days])

  const summaries = useMemo(() => {
    const result: Record<string, ReturnType<typeof summarizeAttendance>> = {}
    for (const profile of profiles) {
      const profileEntries = dayNumbers.map((day) => {
        const cell = grid[entryKey(profile.id, day)]
        return { day, morning: cell?.morning ?? '', afternoon: cell?.afternoon ?? '' }
      })
      result[profile.id] = summarizeAttendance(profileEntries)
    }
    return result
  }, [profiles, grid, dayNumbers])

  function selectMonth(month: string) {
    setCurrentMonth(month)
    router.push(`/finance/attendance?month=${month}`)
  }

  function handleCreate() {
    if (!createMonth) {
      toast.error('请选择月份')
      return
    }
    startTransition(async () => {
      const result = await createAttendanceSheet({
        month: `${createMonth}-01`,
        note: createNote.trim() ? createNote.trim() : null,
      })
      if (result.ok) {
        toast.success('考勤表已创建')
        setCreateOpen(false)
        setCreateMonth('')
        setCreateNote('')
        selectMonth(`${createMonth}-01`)
      } else {
        toast.error(result.error ?? '创建失败')
      }
    })
  }

  function handleCellChange(profileId: string, day: number, half: 'morning' | 'afternoon', value: string) {
    const key = entryKey(profileId, day)
    const cell = grid[key] ?? { morning: '', afternoon: '' }
    const next = { ...cell, [half]: value }
    setGrid((current) => ({ ...current, [key]: next }))
    if (!canManage || !sheet) return
    const { morning, afternoon } = next
    startTransition(async () => {
      const result = await upsertAttendanceEntry({
        sheet_id: sheet.id,
        profile_id: profileId,
        day,
        morning,
        afternoon,
      })
      if (!result.ok) toast.error(result.error ?? '保存失败')
    })
  }

  const daySymbols = ATTENDANCE_SYMBOLS.filter(({ kind }) => kind === 'day')
  const timeSymbols = ATTENDANCE_SYMBOLS.filter(({ kind }) => kind === 'times')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={currentMonth || undefined} onValueChange={selectMonth}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="选择月份" />
          </SelectTrigger>
          <SelectContent>
            {sheets.map((entry) => (
              <SelectItem key={entry.id} value={entry.month}>
                {monthLabel(entry.month)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canManage && (
          <>
            <Button
              variant="outline"
              onClick={() => {
                setCreateMonth('')
                setCreateNote('')
                setCreateOpen(true)
              }}
            >
              新建考勤表
            </Button>
            {sheet && (
              <Button variant="destructive" disabled={pending} onClick={() => setDeleteOpen(true)}>
                删除本月
              </Button>
            )}
          </>
        )}
        {!canManage && sheet && (
          <Badge variant="secondary">{monthLabel(sheet.month)}</Badge>
        )}
      </div>

      {!sheet ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {canManage
              ? '还没有考勤表，点击「新建考勤表」开始。'
              : '暂无考勤记录。'}
          </CardContent>
        </Card>
      ) : (
        <>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Label htmlFor="attendance_note" className="text-muted-foreground">
                备注
              </Label>
              <Input
                id="attendance_note"
                className="max-w-md"
                maxLength={500}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                onBlur={() => {
                  if (note.trim() === (initialNote ?? '')) return
                  startTransition(async () => {
                    const result = await updateAttendanceSheetNote({
                      sheet_id: sheet.id,
                      note: note.trim(),
                    })
                    if (result.ok) toast.success('备注已保存')
                    else toast.error(result.error ?? '保存失败')
                  })
                }}
              />
            </div>
          )}
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-10 bg-background min-w-20">姓名</TableHead>
                  <TableHead className="sticky left-20 z-10 bg-background w-12">上/下午</TableHead>
                  {dayNumbers.map((day) => {
                    const weekday =
                      WEEKDAY_LABELS[
                        new Date(
                          Number(sheet.month.slice(0, 4)),
                          Number(sheet.month.slice(5, 7)) - 1,
                          day,
                        ).getDay()
                      ]
                    const isWeekend = weekday === '六' || weekday === '日'
                    return (
                      <TableHead
                        key={day}
                        className={`w-9 px-1 text-center ${isWeekend ? 'text-muted-foreground' : ''}`}
                      >
                        <div className="text-[10px] leading-tight">{weekday}</div>
                        <div className="text-xs leading-tight">{day}</div>
                      </TableHead>
                    )
                  })}
                  {daySymbols.map(({ symbol, label }) => (
                    <TableHead key={symbol} className="w-10 px-1 text-center text-xs">
                      {symbol}
                      <div className="text-[10px] font-normal">{label}</div>
                    </TableHead>
                  ))}
                  {timeSymbols.map(({ symbol, label }) => (
                    <TableHead key={symbol} className="w-10 px-1 text-center text-xs">
                      {symbol}
                      <div className="text-[10px] font-normal">{label}</div>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {profiles.map((profile) => {
                  const summary = summaries[profile.id]
                  return (
                    <FragmentRows
                      key={profile.id}
                      profile={profile}
                      dayNumbers={dayNumbers}
                      grid={grid}
                      canManage={canManage}
                      summary={summary}
                      onChange={handleCellChange}
                    />
                  )
                })}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {ATTENDANCE_SYMBOLS.map(({ symbol, label }) => (
              <span key={symbol}>
                {symbol} {label}
              </span>
            ))}
            <span>· 未标记</span>
          </div>
          {!canManage && (
            <p className="text-xs text-muted-foreground">考勤由财务维护，如有疑问请联系财务核对。</p>
          )}
        </>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建考勤表</DialogTitle>
            <DialogDescription>按月份创建，员工考勤格初始为空，逐项点选维护。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="attendance_month">月份（必填）</Label>
              <Input
                id="attendance_month"
                type="month"
                value={createMonth}
                onChange={(event) => setCreateMonth(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="attendance_create_note">备注（可选）</Label>
              <Input
                id="attendance_create_note"
                maxLength={500}
                value={createNote}
                onChange={(event) => setCreateNote(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button disabled={pending || !createMonth} onClick={handleCreate}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除考勤表</DialogTitle>
            <DialogDescription>
              删除 {sheet ? monthLabel(sheet.month) : ''} 的全部考勤记录，不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                setDeleteOpen(false)
                if (!sheet) return
                startTransition(async () => {
                  const result = await deleteAttendanceSheet({ sheet_id: sheet.id })
                  if (result.ok) {
                    toast.success('考勤表已删除')
                    router.push('/finance/attendance')
                  } else {
                    toast.error(result.error ?? '删除失败')
                  }
                })
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function FragmentRows({
  profile,
  dayNumbers,
  grid,
  canManage,
  summary,
  onChange,
}: {
  profile: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'>
  dayNumbers: number[]
  grid: Record<string, { morning: string; afternoon: string }>
  canManage: boolean
  summary: ReturnType<typeof summarizeAttendance>
  onChange: (profileId: string, day: number, half: 'morning' | 'afternoon', value: string) => void
}) {
  return (
    <>
      {(['morning', 'afternoon'] as const).map((half, halfIndex) => (
        <TableRow key={`${profile.id}-${half}`}>
          {halfIndex === 0 && (
            <TableCell rowSpan={2} className="sticky left-0 z-10 bg-background whitespace-nowrap font-medium">
              {displayProfileName(profile)}
            </TableCell>
          )}
          <TableCell className="sticky left-20 z-10 bg-background px-1 text-center text-xs text-muted-foreground">
            {half === 'morning' ? '上午' : '下午'}
          </TableCell>
          {dayNumbers.map((day) => {
            const cell = grid[entryKey(profile.id, day)]
            const value = cell?.[half] ?? ''
            if (!canManage) {
              return (
                <TableCell key={day} className="px-1 text-center text-sm">
                  {value || <span className="text-muted-foreground">·</span>}
                </TableCell>
              )
            }
            return (
              <TableCell key={day} className="p-0">
                <select
                  aria-label={`${displayProfileName(profile)} ${day}日${half === 'morning' ? '上午' : '下午'}`}
                  className="h-8 w-full cursor-pointer appearance-none bg-transparent text-center text-sm outline-none hover:bg-accent focus:bg-accent"
                  value={value}
                  onChange={(event) => onChange(profile.id, day, half, event.target.value)}
                >
                  {CELL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </TableCell>
            )
          })}
          {halfIndex === 0 &&
            ATTENDANCE_SYMBOLS.map(({ symbol, kind }) => (
              <TableCell
                key={symbol}
                rowSpan={2}
                className="px-1 text-center text-sm font-medium"
              >
                {summary.counts[symbol] ?? 0}
                {kind === 'times' && <span className="text-[10px] font-normal"> 次</span>}
              </TableCell>
            ))}
        </TableRow>
      ))}
    </>
  )
}
