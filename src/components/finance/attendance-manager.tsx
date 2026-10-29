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

const EMPTY_CELL = { morning: '', afternoon: '' }

// 拖拽框选时向上寻找真正滚动的容器（页面里纵向滚动在 layout 的 main 上）
function findVerticalScroller(element: HTMLElement | null): HTMLElement | null {
  let node = element?.parentElement ?? null
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) return node
    node = node.parentElement
  }
  return null
}

interface CellPos {
  row: number
  day: number
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
  // 编辑态：只有进入编辑后才能改格子和备注，点保存才落库
  const [editing, setEditing] = useState(false)
  // 框选范围：row 为「成员序号 × 2 + 上午/下午」，用于矩形批量填充
  const [selection, setSelection] = useState<{ anchor: CellPos; focus: CellPos } | null>(null)
  const selectingRef = useRef(false)
  const tableWrapRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    setCurrentMonth(selectedMonth)
  }, [selectedMonth])

  useEffect(() => {
    setEditing(false)
    setSelection(null)
  }, [selectedMonth, selectedSheetId])

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

  // 框选：拖动时按指针位置更新焦点；指针靠近边缘自动滚动，支持跨屏选择
  useEffect(() => {
    function updateFocusFromPoint(x: number, y: number) {
      const element = document.elementFromPoint(x, y)
      const cell = element?.closest<HTMLElement>('[data-att-cell]')
      if (!cell) return
      const row = Number(cell.dataset.attRow)
      const day = Number(cell.dataset.attDay)
      if (Number.isNaN(row) || Number.isNaN(day)) return
      setSelection((current) => (current ? { ...current, focus: { row, day } } : current))
    }

    function step() {
      frameRef.current = null
      const pointer = pointerRef.current
      if (!selectingRef.current || !pointer) return
      const EDGE = 56
      const MAX_STEP = 18
      const speedFor = (overshoot: number) =>
        Math.min(MAX_STEP, Math.max(1, Math.ceil((overshoot / EDGE) * MAX_STEP)))

      const scroller = scrollerRef.current
      const wrap = tableWrapRef.current
      const top = scroller ? scroller.getBoundingClientRect().top : 0
      const bottom = Math.min(
        scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight,
        window.innerHeight,
      )
      let dy = 0
      if (pointer.y < top + EDGE) dy = -speedFor(top + EDGE - pointer.y)
      else if (pointer.y > bottom - EDGE) dy = speedFor(pointer.y - (bottom - EDGE))

      let dx = 0
      if (wrap) {
        const rect = wrap.getBoundingClientRect()
        if (pointer.x < rect.left + EDGE) dx = -speedFor(rect.left + EDGE - pointer.x)
        else if (pointer.x > rect.right - EDGE) dx = speedFor(pointer.x - (rect.right - EDGE))
      }

      let moved = false
      if (dy !== 0) {
        if (scroller) {
          const before = scroller.scrollTop
          scroller.scrollTop += dy
          moved = scroller.scrollTop !== before
        } else {
          const before = window.scrollY
          window.scrollBy(0, dy)
          moved = window.scrollY !== before
        }
      }
      if (dx !== 0 && wrap) {
        const before = wrap.scrollLeft
        wrap.scrollLeft += dx
        moved = moved || wrap.scrollLeft !== before
      }
      if (!moved) return
      updateFocusFromPoint(pointer.x, pointer.y)
      frameRef.current = requestAnimationFrame(step)
    }

    function handlePointerMove(event: PointerEvent) {
      if (!selectingRef.current) return
      // 在窗口外松开时收不到 mouseup，用按键状态兜底结束框选
      if (event.buttons === 0) {
        endSelecting()
        return
      }
      pointerRef.current = { x: event.clientX, y: event.clientY }
      updateFocusFromPoint(event.clientX, event.clientY)
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(step)
    }

    function endSelecting() {
      selectingRef.current = false
      pointerRef.current = null
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('mouseup', endSelecting)
    window.addEventListener('pointercancel', endSelecting)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('mouseup', endSelecting)
      window.removeEventListener('pointercancel', endSelecting)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [])

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

  // 已落库的基线，用于统计改动量和放弃修改时还原
  const baseCells = useMemo(() => {
    const map: Record<string, { morning: string; afternoon: string }> = {}
    for (const entry of entries) {
      map[entryKey(entry.member_id, entry.day)] = {
        morning: entry.morning,
        afternoon: entry.afternoon,
      }
    }
    return map
  }, [entries])

  const selectionBounds = useMemo(() => {
    if (!selection) return null
    return {
      rowStart: Math.min(selection.anchor.row, selection.focus.row),
      rowEnd: Math.max(selection.anchor.row, selection.focus.row),
      dayStart: Math.min(selection.anchor.day, selection.focus.day),
      dayEnd: Math.max(selection.anchor.day, selection.focus.day),
    }
  }, [selection])

  const selectedCount = selectionBounds
    ? (selectionBounds.rowEnd - selectionBounds.rowStart + 1) *
      (selectionBounds.dayEnd - selectionBounds.dayStart + 1)
    : 0

  function collectChanges() {
    const items: { member_id: string; day: number; morning: string; afternoon: string }[] = []
    for (const member of visibleMembers) {
      for (const day of dayNumbers) {
        const key = entryKey(member.id, day)
        const cell = grid[key] ?? EMPTY_CELL
        const base = baseCells[key] ?? EMPTY_CELL
        if (cell.morning === base.morning && cell.afternoon === base.afternoon) continue
        items.push({ member_id: member.id, day, morning: cell.morning, afternoon: cell.afternoon })
      }
    }
    return items
  }

  function hasUnsavedChanges() {
    if (note.trim() !== (initialNote ?? '').trim()) return true
    return collectChanges().length > 0
  }

  function selectMonth(month: string) {
    if (editing && hasUnsavedChanges() && !window.confirm('有未保存的考勤修改，切换月份会丢弃，确定继续？')) {
      return
    }
    setEditing(false)
    setSelection(null)
    setCurrentMonth(month)
    router.push(`/finance/attendance?month=${month}`)
  }

  function handleStartEdit() {
    setEditing(true)
    setSelection(null)
  }

  function handleCancelEdit() {
    if (hasUnsavedChanges() && !window.confirm('放弃未保存的修改？')) return
    setGrid(baseCells)
    setNote(initialNote)
    setEditing(false)
    setSelection(null)
  }

  function handleSave() {
    if (!sheet) return
    const items = collectChanges()
    const noteChanged = note.trim() !== (initialNote ?? '').trim()
    if (items.length === 0 && !noteChanged) {
      setEditing(false)
      setSelection(null)
      toast('没有需要保存的修改')
      return
    }
    const sheetId = sheet.id
    startTransition(async () => {
      if (items.length > 0) {
        const result = await batchUpsertAttendanceEntries({ sheet_id: sheetId, items })
        if (!result.ok) {
          toast.error(result.error ?? '保存失败')
          return
        }
      }
      if (noteChanged) {
        const result = await updateAttendanceSheetNote({ sheet_id: sheetId, note: note.trim() })
        if (!result.ok) {
          toast.error(result.error ?? '备注保存失败')
          return
        }
      }
      toast.success('考勤已保存')
      setEditing(false)
      setSelection(null)
    })
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

  function startSelection(row: number, day: number) {
    selectingRef.current = true
    scrollerRef.current = findVerticalScroller(tableWrapRef.current)
    setSelection({ anchor: { row, day }, focus: { row, day } })
  }

  function applySymbol(value: string) {
    if (!selectionBounds) {
      toast.error('请先在表格中框选要填充的单元格')
      return
    }
    const { rowStart, rowEnd, dayStart, dayEnd } = selectionBounds
    setGrid((current) => {
      const next = { ...current }
      for (let row = rowStart; row <= rowEnd; row += 1) {
        const member = visibleMembers[Math.floor(row / 2)]
        if (!member) continue
        const half = row % 2 === 0 ? 'morning' : 'afternoon'
        for (let day = dayStart; day <= dayEnd; day += 1) {
          const key = entryKey(member.id, day)
          next[key] = { ...(next[key] ?? EMPTY_CELL), [half]: value }
        }
      }
      return next
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
            {!editing && (
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
            )}
            {sheet && (
              <>
                {editing ? (
                  <>
                    <Button disabled={pending} onClick={handleSave}>
                      {pending ? '保存中…' : '保存'}
                    </Button>
                    <Button variant="outline" disabled={pending} onClick={handleCancelEdit}>
                      取消
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" onClick={handleStartEdit}>
                      编辑
                    </Button>
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
          </>
        )}
        {!canManage && sheet && <Badge variant="secondary">{monthLabel(sheet.month)}</Badge>}
      </div>

      {canManage && sheet && editing && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">填充：</span>
          {CELL_OPTIONS.map((option) => (
            <Button
              key={option.value || 'clear'}
              size="sm"
              variant="outline"
              className="px-2"
              onClick={() => applySymbol(option.value)}
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
          <span className="text-xs text-muted-foreground">
            {selectedCount > 0
              ? `已选 ${selectedCount} 格，点击符号批量填充`
              : '在表格中按住拖动框选单元格，再点击上方符号批量填充'}
          </span>
          {selection && (
            <Button size="sm" variant="ghost" onClick={() => setSelection(null)}>
              取消选择
            </Button>
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
              {editing ? (
                <Input
                  id="attendance_note"
                  className="max-w-md"
                  maxLength={500}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              ) : (
                <span className="text-muted-foreground">{note.trim() || '—'}</span>
              )}
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
            <div ref={tableWrapRef} className="overflow-x-auto rounded-md border">
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
                  {visibleMembers.map((member, memberIndex) => {
                    const summary = summaries[member.id]
                    return (
                      <MemberRows
                        key={member.id}
                        member={member}
                        memberIndex={memberIndex}
                        dayNumbers={dayNumbers}
                        grid={grid}
                        editable={canManage && editing}
                        selectionBounds={selectionBounds}
                        summary={summary}
                        onSelectStart={startSelection}
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
            <span>天数字段按上/下午各计 0.5 天</span>
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
              按月份创建，创建后在「人员」中添加成员，进入编辑后框选单元格批量填写考勤。
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
  memberIndex,
  dayNumbers,
  grid,
  editable,
  selectionBounds,
  summary,
  onSelectStart,
}: {
  member: Pick<AttendanceMember, 'id' | 'name' | 'profile_id'>
  memberIndex: number
  dayNumbers: number[]
  grid: Record<string, { morning: string; afternoon: string }>
  editable: boolean
  selectionBounds: {
    rowStart: number
    rowEnd: number
    dayStart: number
    dayEnd: number
  } | null
  summary: ReturnType<typeof summarizeAttendance>
  onSelectStart: (row: number, day: number) => void
}) {
  return (
    <>
      {(['morning', 'afternoon'] as const).map((half, halfIndex) => {
        const row = memberIndex * 2 + halfIndex
        return (
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
              if (!editable) {
                return (
                  <TableCell key={day} className="w-8 px-0.5 text-center text-xs">
                    {value || <span className="text-muted-foreground">·</span>}
                  </TableCell>
                )
              }
              const selected = selectionBounds
                ? row >= selectionBounds.rowStart &&
                  row <= selectionBounds.rowEnd &&
                  day >= selectionBounds.dayStart &&
                  day <= selectionBounds.dayEnd
                : false
              return (
                <TableCell key={day} className="w-8 p-0">
                  <div
                    aria-label={`${member.name} ${day}日${half === 'morning' ? '上午' : '下午'}`}
                    data-att-cell=""
                    data-att-row={row}
                    data-att-day={day}
                    className={`flex h-7 w-full cursor-cell select-none items-center justify-center text-xs hover:bg-accent ${
                      selected ? 'bg-primary/15' : ''
                    }`}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      onSelectStart(row, day)
                    }}
                  >
                    {value || <span className="text-muted-foreground/40">·</span>}
                  </div>
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
        )
      })}
    </>
  )
}
