'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Download, Eraser, Users } from 'lucide-react'
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
  addAttendanceMember,
  batchUpsertAttendanceEntries,
  createAttendanceSheet,
  deleteAttendanceSheet,
  removeAttendanceMember,
  updateAttendanceSheetNote,
  upsertAttendanceEntry,
} from '@/lib/actions/attendance'
import { exportAttendanceSheet } from '@/lib/attendance-export'
import { ATTENDANCE_SYMBOLS, summarizeAttendance } from '@/lib/attendance'
import type { AttendanceEntry, AttendanceMember, AttendanceSheet, Profile } from '@/types'

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

function entryKey(memberId: string, day: number) {
  return `${memberId}:${day}`
}

export function AttendanceManager({
  canManage,
  sheets,
  members,
  accounts,
  entries,
  selectedMonth,
  selectedSheetId,
  initialNote,
  currentProfileId,
}: {
  canManage: boolean
  sheets: AttendanceSheet[]
  members: AttendanceMember[]
  accounts: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'>[]
  entries: AttendanceEntry[]
  selectedMonth: string
  selectedSheetId: string
  initialNote: string
  currentProfileId: string
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
  const [memberOpen, setMemberOpen] = useState(false)
  const [addAccountId, setAddAccountId] = useState('')
  const [manualName, setManualName] = useState('')
  const [exporting, setExporting] = useState(false)
  // 笔刷：null = 点选模式；'' = 清除；其余为符号
  const [brush, setBrush] = useState<string | null>(null)
  const paintingRef = useRef(false)
  const paintedKeysRef = useRef<Set<string>>(new Set())
  const gridRef = useRef(grid)
  gridRef.current = grid

  useEffect(() => {
    setCurrentMonth(selectedMonth)
  }, [selectedMonth])

  useEffect(() => {
    const next: Record<string, { morning: string; afternoon: string }> = {}
    for (const entry of entries) {
      next[entryKey(entry.member_id, entry.day)] = {
        morning: entry.morning,
        afternoon: entry.afternoon,
      }
    }
    setGrid(next)
    setNote(initialNote)
  }, [entries, initialNote])

  // 刷选期间松开鼠标：统一批量保存
  useEffect(() => {
    function endPainting() {
      if (!paintingRef.current) return
      paintingRef.current = false
      const keys = [...paintedKeysRef.current]
      paintedKeysRef.current = new Set()
      if (keys.length === 0) return
      const current = gridRef.current
      const items = keys.map((key) => {
        const [memberId, dayStr] = key.split(':')
        const cell = current[key] ?? { morning: '', afternoon: '' }
        return {
          member_id: memberId,
          day: Number(dayStr),
          morning: cell.morning,
          afternoon: cell.afternoon,
        }
      })
      startTransition(async () => {
        const result = await batchUpsertAttendanceEntries({ sheet_id: selectedSheetId, items })
        if (!result.ok) toast.error(result.error ?? '批量保存失败')
      })
    }
    window.addEventListener('mouseup', endPainting)
    window.addEventListener('pointercancel', endPainting)
    return () => {
      window.removeEventListener('mouseup', endPainting)
      window.removeEventListener('pointercancel', endPainting)
    }
  }, [selectedSheetId])

  const sheet = sheets.find((entry) => entry.month === currentMonth) ?? null
  const visibleMembers = useMemo(
    () =>
      canManage ? members : members.filter((member) => member.profile_id === currentProfileId),
    [canManage, members, currentProfileId],
  )
  const days = sheet ? daysInMonth(sheet.month) : 0
  const dayNumbers = useMemo(() => Array.from({ length: days }, (_, i) => i + 1), [days])

  const summaries = useMemo(() => {
    const result: Record<string, ReturnType<typeof summarizeAttendance>> = {}
    for (const member of visibleMembers) {
      const memberEntries = dayNumbers.map((day) => {
        const cell = grid[entryKey(member.id, day)]
        return { day, morning: cell?.morning ?? '', afternoon: cell?.afternoon ?? '' }
      })
      result[member.id] = summarizeAttendance(memberEntries)
    }
    return result
  }, [visibleMembers, grid, dayNumbers])

  const accountsNotInSheet = useMemo(
    () => accounts.filter((account) => !members.some((member) => member.profile_id === account.id)),
    [accounts, members],
  )

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

  function handleAddAccount() {
    if (!sheet || !addAccountId) return
    startTransition(async () => {
      const result = await addAttendanceMember({ sheet_id: sheet.id, profile_id: addAccountId })
      if (result.ok) {
        toast.success('已添加成员')
        setAddAccountId('')
      } else {
        toast.error(result.error ?? '添加失败')
      }
    })
  }

  function handleAddManual() {
    if (!sheet) return
    const name = manualName.trim()
    if (!name) {
      toast.error('请填写姓名')
      return
    }
    startTransition(async () => {
      const result = await addAttendanceMember({ sheet_id: sheet.id, name })
      if (result.ok) {
        toast.success('已添加成员')
        setManualName('')
      } else {
        toast.error(result.error ?? '添加失败')
      }
    })
  }

  function handleRemoveMember(member: AttendanceMember) {
    if (!window.confirm(`移除「${member.name}」？其全部考勤记录将一并删除。`)) return
    startTransition(async () => {
      const result = await removeAttendanceMember({ member_id: member.id })
      if (result.ok) toast.success('已移除成员')
      else toast.error(result.error ?? '移除失败')
    })
  }

  function handleAddAllAccounts() {
    if (!sheet || accountsNotInSheet.length === 0) return
    const sheetId = sheet.id
    startTransition(async () => {
      let failed = 0
      for (const account of accountsNotInSheet) {
        const result = await addAttendanceMember({ sheet_id: sheetId, profile_id: account.id })
        if (!result.ok) failed += 1
      }
      if (failed > 0) toast.error(`有 ${failed} 个成员添加失败`)
      else toast.success('已添加全部账号')
    })
  }

  async function handleExport() {
    if (!sheet) return
    setExporting(true)
    try {
      await exportAttendanceSheet({
        month: sheet.month,
        note,
        members: visibleMembers,
        entries,
      })
    } catch (error) {
      toast.error(`导出失败：${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setExporting(false)
    }
  }

  function handleCellChange(
    memberId: string,
    day: number,
    half: 'morning' | 'afternoon',
    value: string,
  ) {
    const key = entryKey(memberId, day)
    const cell = grid[key] ?? { morning: '', afternoon: '' }
    const next = { ...cell, [half]: value }
    setGrid((current) => ({ ...current, [key]: next }))
    if (!canManage || !sheet) return
    const { morning, afternoon } = next
    startTransition(async () => {
      const result = await upsertAttendanceEntry({
        sheet_id: sheet.id,
        member_id: memberId,
        day,
        morning,
        afternoon,
      })
      if (!result.ok) toast.error(result.error ?? '保存失败')
    })
  }

  function applyBrush(memberId: string, day: number, half: 'morning' | 'afternoon') {
    // 仅在按住拖动期间上色，纯悬停不生效
    if (brush === null || !sheet || !paintingRef.current) return
    const key = entryKey(memberId, day)
    const cell = gridRef.current[key] ?? { morning: '', afternoon: '' }
    if ((cell[half] ?? '') === brush) return
    const next = { ...cell, [half]: brush }
    setGrid((current) => ({ ...current, [key]: next }))
    paintedKeysRef.current.add(key)
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
              <>
                <Button variant="outline" onClick={() => setMemberOpen(true)}>
                  <Users className="mr-1.5 h-4 w-4" />
                  人员（{members.length}）
                </Button>
                <Button variant="outline" disabled={exporting} onClick={handleExport}>
                  <Download className="mr-1.5 h-4 w-4" />
                  {exporting ? '导出中…' : '导出本月'}
                </Button>
                <Button variant="destructive" disabled={pending} onClick={() => setDeleteOpen(true)}>
                  删除本月
                </Button>
              </>
            )}
          </>
        )}
        {!canManage && sheet && <Badge variant="secondary">{monthLabel(sheet.month)}</Badge>}
      </div>

      {canManage && sheet && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">批量：</span>
          <Button
            size="sm"
            variant={brush === null ? 'default' : 'outline'}
            onClick={() => setBrush(null)}
          >
            点选
          </Button>
          {CELL_OPTIONS.map((option) => (
            <Button
              key={option.value || 'clear'}
              size="sm"
              variant={brush === option.value ? 'default' : 'outline'}
              className="px-2"
              onClick={() => setBrush(option.value)}
            >
              {option.value === '' ? (
                <>
                  <Eraser className="mr-1 h-3.5 w-3.5" />
                  清除
                </>
              ) : (
                option.label
              )}
            </Button>
          ))}
          {brush !== null && (
            <span className="text-xs text-muted-foreground">在表格上按住拖动，即可连续填充该符号。</span>
          )}
        </div>
      )}

      {!sheet ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {canManage ? '还没有考勤表，点击「新建考勤表」开始。' : '暂无考勤记录。'}
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
          {visibleMembers.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                {canManage
                  ? '本月还没有人员，点击上方「人员」添加账号成员或手动录入。'
                  : '本月考勤表中没有你的记录。'}
              </CardContent>
            </Card>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 z-10 w-16 bg-background px-1">
                      姓名
                    </TableHead>
                    <TableHead className="sticky left-16 z-10 w-9 bg-background px-0.5 text-center text-[10px]">
                      上/下午
                    </TableHead>
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
                          className={`w-8 px-0.5 text-center ${isWeekend ? 'text-muted-foreground' : ''}`}
                        >
                          <div className="text-[9px] leading-tight">{weekday}</div>
                          <div className="text-[11px] leading-tight">{day}</div>
                        </TableHead>
                      )
                    })}
                    {daySymbols.map(({ symbol, label }) => (
                      <TableHead key={symbol} className="w-9 px-0.5 text-center text-[11px]">
                        {symbol}
                        <div className="text-[9px] font-normal">{label}</div>
                      </TableHead>
                    ))}
                    {timeSymbols.map(({ symbol, label }) => (
                      <TableHead key={symbol} className="w-9 px-0.5 text-center text-[11px]">
                        {symbol}
                        <div className="text-[9px] font-normal">{label}</div>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleMembers.map((member) => {
                    const summary = summaries[member.id]
                    return (
                      <MemberRows
                        key={member.id}
                        member={member}
                        dayNumbers={dayNumbers}
                        grid={grid}
                        canManage={canManage}
                        brushActive={brush !== null}
                        summary={summary}
                        onChange={handleCellChange}
                        onBrush={applyBrush}
                        onStartPaint={() => {
                          paintingRef.current = true
                        }}
                      />
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
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
            <DialogDescription>
              按月份创建，创建后在「人员」中添加成员，再逐项点选或用笔刷维护考勤。
            </DialogDescription>
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

      <Dialog open={memberOpen} onOpenChange={setMemberOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>考勤人员（{sheet ? monthLabel(sheet.month) : ''}）</DialogTitle>
            <DialogDescription>
              可从系统账号添加，也可手动录入无账号人员；移除成员会一并删除其考勤记录。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              {members.length === 0 && (
                <p className="text-sm text-muted-foreground">本月还没有成员。</p>
              )}
              {members.map((member) => (
                <div key={member.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{member.name}</span>
                    <Badge variant={member.profile_id ? 'secondary' : 'outline'} className="shrink-0 text-[10px]">
                      {member.profile_id ? '账号' : '手动'}
                    </Badge>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-destructive"
                    disabled={pending}
                    onClick={() => handleRemoveMember(member)}
                  >
                    移除
                  </Button>
                </div>
              ))}
            </div>
            <div className="space-y-2 border-t pt-3">
              <div className="flex items-end gap-2">
                <div className="grid flex-1 gap-1.5">
                  <Label>从账号添加</Label>
                  <Select value={addAccountId || undefined} onValueChange={setAddAccountId}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择账号" />
                    </SelectTrigger>
                    <SelectContent>
                      {accountsNotInSheet.length === 0 && (
                        <SelectItem value="__none" disabled>
                          全部账号都已在表中
                        </SelectItem>
                      )}
                      {accountsNotInSheet.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.chinese_name?.trim() || account.full_name}
                          {account.chinese_name?.trim() ? `（${account.full_name}）` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  variant="outline"
                  disabled={pending || !addAccountId || addAccountId === '__none'}
                  onClick={handleAddAccount}
                >
                  添加
                </Button>
              </div>
              <div className="flex items-end gap-2">
                <div className="grid flex-1 gap-1.5">
                  <Label htmlFor="attendance_manual_name">手动添加（无账号）</Label>
                  <Input
                    id="attendance_manual_name"
                    maxLength={50}
                    placeholder="姓名"
                    value={manualName}
                    onChange={(event) => setManualName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') handleAddManual()
                    }}
                  />
                </div>
                <Button
                  variant="outline"
                  disabled={pending || !manualName.trim()}
                  onClick={handleAddManual}
                >
                  添加
                </Button>
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={pending || accountsNotInSheet.length === 0}
                onClick={handleAddAllAccounts}
              >
                一键添加全部账号（{accountsNotInSheet.length}）
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setMemberOpen(false)}>完成</Button>
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

function MemberRows({
  member,
  dayNumbers,
  grid,
  canManage,
  brushActive,
  summary,
  onChange,
  onBrush,
  onStartPaint,
}: {
  member: Pick<AttendanceMember, 'id' | 'name' | 'profile_id'>
  dayNumbers: number[]
  grid: Record<string, { morning: string; afternoon: string }>
  canManage: boolean
  brushActive: boolean
  summary: ReturnType<typeof summarizeAttendance>
  onChange: (memberId: string, day: number, half: 'morning' | 'afternoon', value: string) => void
  onBrush: (memberId: string, day: number, half: 'morning' | 'afternoon') => void
  onStartPaint: () => void
}) {
  return (
    <>
      {(['morning', 'afternoon'] as const).map((half, halfIndex) => (
        <TableRow key={`${member.id}-${half}`}>
          {halfIndex === 0 && (
            <TableCell
              rowSpan={2}
              className="sticky left-0 z-10 w-16 whitespace-nowrap bg-background px-1 text-sm font-medium"
            >
              <span className="block truncate" title={member.name}>
                {member.name}
              </span>
            </TableCell>
          )}
          <TableCell className="sticky left-16 z-10 w-9 bg-background px-0.5 text-center text-[10px] text-muted-foreground">
            {half === 'morning' ? '上午' : '下午'}
          </TableCell>
          {dayNumbers.map((day) => {
            const cell = grid[entryKey(member.id, day)]
            const value = cell?.[half] ?? ''
            if (!canManage) {
              return (
                <TableCell key={day} className="w-8 px-0.5 text-center text-xs">
                  {value || <span className="text-muted-foreground">·</span>}
                </TableCell>
              )
            }
            if (brushActive) {
              return (
                <TableCell key={day} className="w-8 p-0">
                  <div
                    aria-label={`${member.name} ${day}日${half === 'morning' ? '上午' : '下午'}`}
                    className="flex h-7 w-full cursor-crosshair select-none items-center justify-center text-xs hover:bg-accent"
                    onMouseDown={(event) => {
                      event.preventDefault()
                      onStartPaint()
                      onBrush(member.id, day, half)
                    }}
                    onMouseEnter={() => onBrush(member.id, day, half)}
                  >
                    {value || <span className="text-muted-foreground/40">·</span>}
                  </div>
                </TableCell>
              )
            }
            return (
              <TableCell key={day} className="w-8 p-0">
                <select
                  aria-label={`${member.name} ${day}日${half === 'morning' ? '上午' : '下午'}`}
                  className="h-7 w-full cursor-pointer appearance-none bg-transparent text-center text-xs outline-none hover:bg-accent focus:bg-accent"
                  value={value}
                  onChange={(event) => onChange(member.id, day, half, event.target.value)}
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
                className="w-9 px-0.5 text-center text-sm font-medium"
              >
                {summary.counts[symbol] ?? 0}
                {kind === 'times' && <span className="text-[9px] font-normal"> 次</span>}
              </TableCell>
            ))}
        </TableRow>
      ))}
    </>
  )
}
