'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
  addPayrollItem,
  createPayrollSalaryProfile,
  createPayrollSheet,
  deletePayrollSalaryProfile,
  deletePayrollSheet,
  publishPayrollSheet,
  pushPayrollItem,
  removePayrollItem,
  savePayrollSalaryProfile,
  unpublishPayrollSheet,
  unpushPayrollItem,
  updatePayrollItems,
  updatePayrollSheetMeta,
} from '@/lib/actions/payroll'
import {
  calcAttendanceDeduction,
  calcPayroll,
  countWeekdays,
  PAYROLL_SHEET_STATUS_LABELS,
} from '@/lib/payroll'
import { formatCny } from '@/lib/finance'
import { cn, displayProfileName, formatAmount, formatDate } from '@/lib/utils'
import type {
  PayrollItemWithProfile,
  PayrollSalaryProfile,
  PayrollSheet,
  Profile,
} from '@/types'

interface RowDraft {
  attendance_days: string
  base_salary: string
  commission: string
  bonus: string
  attendance_deduction: string
  other_deduction: string
  social_insurance: string
  housing_fund: string
  tax: string
  remark: string
}

const DRAFT_FIELDS: (keyof Omit<RowDraft, 'remark'>)[] = [
  'attendance_days',
  'base_salary',
  'commission',
  'bonus',
  'attendance_deduction',
  'other_deduction',
  'social_insurance',
  'housing_fund',
  'tax',
]

// 填空前置 0 一律留空展示（不填视为 0），金额/天数只有非 0 才回显。
function draftValue(value: number | string) {
  return Number(value) === 0 ? '' : String(Number(value))
}

function buildDraft(item: PayrollItemWithProfile): RowDraft {
  return {
    attendance_days: draftValue(item.attendance_days),
    base_salary: draftValue(item.base_salary),
    commission: draftValue(item.commission),
    bonus: draftValue(item.bonus),
    attendance_deduction: draftValue(item.attendance_deduction),
    other_deduction: draftValue(item.other_deduction),
    social_insurance: draftValue(item.social_insurance),
    housing_fund: draftValue(item.housing_fund),
    tax: draftValue(item.tax),
    remark: item.remark ?? '',
  }
}

function isDirty(item: PayrollItemWithProfile, draft: RowDraft) {
  for (const field of DRAFT_FIELDS) {
    if (Number(draft[field] || 0) !== Number(item[field])) return true
  }
  return draft.remark !== (item.remark ?? '')
}

function draftPayrollValues(draft: RowDraft) {
  return {
    base_salary: Number(draft.base_salary || 0),
    commission: Number(draft.commission || 0),
    bonus: Number(draft.bonus || 0),
    attendance_deduction: Number(draft.attendance_deduction || 0),
    other_deduction: Number(draft.other_deduction || 0),
    social_insurance: Number(draft.social_insurance || 0),
    housing_fund: Number(draft.housing_fund || 0),
    tax: Number(draft.tax || 0),
  }
}

function monthLabel(month: string) {
  return `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`
}

interface SalaryDraft {
  name: string
  base_salary: string
  social_insurance: string
  housing_fund: string
}

function buildSalaryDraft(row: PayrollSalaryProfile): SalaryDraft {
  return {
    name: row.name,
    base_salary: draftValue(row.base_salary),
    social_insurance: draftValue(row.social_insurance),
    housing_fund: draftValue(row.housing_fund),
  }
}

function payrollItemName(item: PayrollItemWithProfile) {
  return item.profile ? displayProfileName(item.profile) : item.employee_name
}

function payrollStaffLabel(row: PayrollSalaryProfile) {
  return row.profile_id ? `${row.name}（账号）` : `${row.name}（无账号）`
}

function toMonthInputValue(month: string | null) {
  return month ? month.slice(0, 7) : ''
}

function fromMonthInputValue(value: string) {
  return value ? `${value}-01` : null
}

export function PayrollManager({
  canManage,
  myProfileId,
  sheets,
  items,
  profiles,
  salaryProfiles,
  selectedMonth,
}: {
  canManage: boolean
  myProfileId: string
  sheets: PayrollSheet[]
  items: PayrollItemWithProfile[]
  profiles: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'>[]
  salaryProfiles: PayrollSalaryProfile[]
  selectedMonth: string
}) {
  const [currentMonth, setCurrentMonth] = useState(selectedMonth)
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({})
  const [deductionTouched, setDeductionTouched] = useState<Record<string, boolean>>({})
  const [fullDaysOverride, setFullDaysOverride] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [salaryOpen, setSalaryOpen] = useState(false)
  const [salaryDrafts, setSalaryDrafts] = useState<Record<string, SalaryDraft>>({})
  const [salaryAddProfileId, setSalaryAddProfileId] = useState('')
  const [salaryAddOpen, setSalaryAddOpen] = useState(false)
  const [salaryManualName, setSalaryManualName] = useState('')
  const [salaryDeleteTarget, setSalaryDeleteTarget] = useState<PayrollSalaryProfile | null>(null)
  const [pending, startTransition] = useTransition()
  const [createOpen, setCreateOpen] = useState(false)
  const [createPeriod, setCreatePeriod] = useState('')
  const [createPayout, setCreatePayout] = useState('')
  const [publishOpen, setPublishOpen] = useState(false)
  const [unpublishOpen, setUnpublishOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [addStaffId, setAddStaffId] = useState('')
  const [addStaffOpen, setAddStaffOpen] = useState(false)
  const [manualStaffName, setManualStaffName] = useState('')
  const [discardOpen, setDiscardOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<PayrollItemWithProfile | null>(null)

  const sheet = sheets.find((entry) => entry.period_month === currentMonth) ?? null
  // 已推送的行对外承诺不能直接改数；可只撤回这一行，改完再单独推送。
  const locked = sheet?.status === 'published'
  const rowLocked = (item: PayrollItemWithProfile) => Boolean(locked && item.pushed_at)
  const sheetItems = useMemo(
    () => items.filter((item) => item.sheet_id === sheet?.id),
    [items, sheet?.id],
  )
  const effectiveFullDays =
    fullDaysOverride ?? sheet?.full_attendance_days ?? countWeekdays(currentMonth.slice(0, 7))

  // 切表/切月一律回到只读，避免把上一张表的编辑态带过去
  useEffect(() => {
    setEditing(false)
    setAddStaffId('')
    setManualStaffName('')
    setRemoveTarget(null)
  }, [sheet?.id])

  // 薪资档案增删后（而不是改金额后）重建编辑草稿
  const salaryRosterKey = salaryProfiles
    .map((row) => `${row.id}:${row.profile_id ?? ''}`)
    .join('|')
  useEffect(() => {
    if (!salaryOpen) return
    const next: Record<string, SalaryDraft> = {}
    for (const row of salaryProfiles) next[row.id] = buildSalaryDraft(row)
    setSalaryDrafts(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salaryRosterKey, salaryOpen])

  const deductionTouchedRef = useRef<Record<string, boolean>>({})
  deductionTouchedRef.current = deductionTouched

  useEffect(() => {
    const next: Record<string, RowDraft> = {}
    const fullDays = fullDaysOverride ?? sheet?.full_attendance_days ?? null
    for (const item of items) {
      const existing = drafts[item.id]
      // 编辑态下保留未保存的输入：补入人员、改满勤天数等会触发服务端刷新，不能冲掉正在填的行。
      if (editing && existing && isDirty(item, existing)) {
        next[item.id] = existing
        continue
      }
      const draft = buildDraft(item)
      // 未手动改过的扣款行始终按公式回算：满勤天数调整后服务端旧值不会把客户端联动值盖掉。
      if (!deductionTouchedRef.current[item.id]) {
        const days =
          fullDays ?? countWeekdays(
            (sheets.find((entry) => entry.id === item.sheet_id)?.period_month ?? currentMonth).slice(0, 7),
          )
        draft.attendance_deduction = draftValue(
          calcAttendanceDeduction(Number(draft.base_salary || 0), days, Number(draft.attendance_days || 0)),
        )
      }
      next[item.id] = draft
    }
    setDrafts(next)
    setFullDaysOverride(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sheet?.id, sheet?.full_attendance_days])

  const dirtyIds = sheetItems
    .filter((item) => !rowLocked(item) && drafts[item.id] && isDirty(item, drafts[item.id]))
    .map((item) => item.id)

  function patchDraft(itemId: string, field: keyof RowDraft, value: string) {
    const target = sheetItems.find((item) => item.id === itemId)
    if (!editing || !target || rowLocked(target)) return
    if (field === 'attendance_deduction') {
      setDeductionTouched((current) => ({ ...current, [itemId]: true }))
    }
    setDrafts((current) => {
      const draft = current[itemId]
      if (!draft) return current
      const next = { ...draft, [field]: value }
      // 底薪/出勤变化时，考勤扣款按公式联动（手动改过的扣款不再覆盖）。
      if (
        (field === 'base_salary' || field === 'attendance_days') &&
        !deductionTouched[itemId]
      ) {
        next.attendance_deduction = draftValue(
          calcAttendanceDeduction(
            Number(next.base_salary || 0),
            effectiveFullDays,
            Number(next.attendance_days || 0),
          ),
        )
      }
      return { ...current, [itemId]: next }
    })
  }

  function recomputeDeductions(fullDays: number | null) {
    setDrafts((current) => {
      const next = { ...current }
      for (const item of sheetItems) {
        const draft = next[item.id]
        if (!draft || deductionTouched[item.id]) continue
        next[item.id] = {
          ...draft,
          attendance_deduction: draftValue(
            calcAttendanceDeduction(
              Number(draft.base_salary || 0),
              fullDays,
              Number(draft.attendance_days || 0),
            ),
          ),
        }
      }
      return next
    })
  }

  function handleFullDaysChange(value: string) {
    if (!sheet || locked || !editing) return
    const days = value === '' ? null : Number(value)
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 31)) return
    startTransition(async () => {
      const result = await updatePayrollSheetMeta({
        sheet_id: sheet.id,
        payout_month: sheet.payout_month,
        full_attendance_days: days,
      })
      if (result.ok) {
        setFullDaysOverride(days)
        recomputeDeductions(days)
        toast.success('已保存')
      } else {
        toast.error(result.error ?? '保存失败')
      }
    })
  }

  function openSalaryDialog() {
    const next: Record<string, SalaryDraft> = {}
    for (const row of salaryProfiles) next[row.id] = buildSalaryDraft(row)
    setSalaryDrafts(next)
    setSalaryAddProfileId('')
    setSalaryManualName('')
    setSalaryOpen(true)
  }

  function runAction(action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await action()
      if (result.ok) {
        toast.success('已保存')
      } else {
        toast.error(result.error ?? '操作失败')
      }
    })
  }

  function handleCreate() {
    if (!createPeriod) {
      toast.error('请选择所属月份')
      return
    }
    startTransition(async () => {
      const result = await createPayrollSheet({
        period_month: fromMonthInputValue(createPeriod) as string,
        payout_month: fromMonthInputValue(createPayout),
      })
      if (result.ok && result.sheet_id) {
        toast.success('工资表已创建，已按薪资档案带入人员')
        setCreateOpen(false)
        setCreatePeriod('')
        setCreatePayout('')
        setCurrentMonth(fromMonthInputValue(createPeriod) as string)
      } else {
        toast.error(result.error ?? '创建失败')
      }
    })
  }

  function handleSaveRows() {
    const rows = dirtyIds
      .map((id) => {
        const draft = drafts[id]
        return {
          id,
          attendance_days: Number(draft.attendance_days || 0),
          base_salary: Number(draft.base_salary || 0),
          commission: Number(draft.commission || 0),
          bonus: Number(draft.bonus || 0),
          attendance_deduction: Number(draft.attendance_deduction || 0),
          other_deduction: Number(draft.other_deduction || 0),
          social_insurance: Number(draft.social_insurance || 0),
          housing_fund: Number(draft.housing_fund || 0),
          tax: Number(draft.tax || 0),
          remark: draft.remark.trim() ? draft.remark.trim() : null,
        }
      })
      .filter((row) => row.attendance_days >= 0)
    if (rows.length === 0) return
    startTransition(async () => {
      const result = await updatePayrollItems({ rows })
      if (result.ok) {
        toast.success(`已保存 ${rows.length} 行`)
        setEditing(false)
        setDeductionTouched({})
      } else {
        toast.error(result.error ?? '保存失败')
      }
    })
  }

  function cancelEditing() {
    const next: Record<string, RowDraft> = {}
    for (const item of items) next[item.id] = buildDraft(item)
    setDrafts(next)
    setDeductionTouched({})
    setEditing(false)
    setAddStaffId('')
    setManualStaffName('')
    setDiscardOpen(false)
  }

  function requestCancelEditing() {
    if (dirtyIds.length > 0) {
      setDiscardOpen(true)
      return
    }
    cancelEditing()
  }

  function handleRemoveItem() {
    if (!removeTarget) return
    const target = removeTarget
    startTransition(async () => {
      const result = await removePayrollItem({ item_id: target.id })
      if (result.ok) {
        toast.success(`已移除 ${target.profile ? displayProfileName(target.profile) : target.employee_name}`)
        setRemoveTarget(null)
      } else {
        toast.error(result.error ?? '移除失败')
      }
    })
  }

  function handleUnpushItem(item: PayrollItemWithProfile) {
    const name = payrollItemName(item)
    startTransition(async () => {
      const result = await unpushPayrollItem({ item_id: item.id })
      if (result.ok) {
        toast.success(`已撤回 ${name} 的工资条，可编辑后重新推送`)
      } else {
        toast.error(result.error ?? '撤回失败')
      }
    })
  }

  function handlePushItem(item: PayrollItemWithProfile) {
    const name = payrollItemName(item)
    startTransition(async () => {
      const result = await pushPayrollItem({ item_id: item.id })
      if (result.ok) {
        toast.success(`已推送 ${name} 的工资条`)
      } else {
        toast.error(result.error ?? '推送失败')
      }
    })
  }

  function handleAddStaff(salaryProfileId: string) {
    if (!sheet) return
    startTransition(async () => {
      const result = await addPayrollItem({
        sheet_id: sheet.id,
        salary_profile_id: salaryProfileId,
      })
      if (result.ok) {
        toast.success('已补入工资表')
        setAddStaffId('')
      } else {
        toast.error(result.error ?? '补入失败')
      }
    })
  }

  function handleAddManualStaff() {
    if (!sheet || !manualStaffName.trim()) return
    const name = manualStaffName.trim()
    startTransition(async () => {
      const result = await addPayrollItem({ sheet_id: sheet.id, name })
      if (result.ok) {
        toast.success(`已补入 ${name}，并写入薪资档案`)
        setManualStaffName('')
      } else {
        toast.error(result.error ?? '补入失败')
      }
    })
  }

  function handleAddSalaryAccount() {
    if (!salaryAddProfileId) return
    startTransition(async () => {
      const result = await createPayrollSalaryProfile({ profile_id: salaryAddProfileId })
      if (result.ok) {
        toast.success('已加入薪资档案，可继续填写金额')
        setSalaryAddProfileId('')
      } else {
        toast.error(result.error ?? '新增失败')
      }
    })
  }

  function handleAddSalaryManual() {
    const name = salaryManualName.trim()
    if (!name) return
    startTransition(async () => {
      const result = await createPayrollSalaryProfile({ name })
      if (result.ok) {
        toast.success('已加入薪资档案，可继续填写金额')
        setSalaryManualName('')
      } else {
        toast.error(result.error ?? '新增失败')
      }
    })
  }

  function handleDeleteSalaryProfile() {
    if (!salaryDeleteTarget) return
    const target = salaryDeleteTarget
    startTransition(async () => {
      const result = await deletePayrollSalaryProfile({ id: target.id })
      if (result.ok) {
        toast.success('已从薪资档案移除')
        setSalaryDeleteTarget(null)
      } else {
        toast.error(result.error ?? '删除失败')
      }
    })
  }

  const usedSalaryProfileIds = new Set(
    sheetItems.map((item) => item.salary_profile_id).filter((value): value is string => Boolean(value)),
  )
  const usedProfileIds = new Set(
    sheetItems.map((item) => item.profile_id).filter((value): value is string => Boolean(value)),
  )
  const approvedProfileIds = new Set(profiles.map((profile) => profile.id))
  const addableStaff = salaryProfiles.filter(
    (row) =>
      !usedSalaryProfileIds.has(row.id) &&
      (!row.profile_id ||
        (approvedProfileIds.has(row.profile_id) && !usedProfileIds.has(row.profile_id))),
  )
  const addableSalaryAccounts = profiles.filter(
    (profile) => !salaryProfiles.some((row) => row.profile_id === profile.id),
  )
  const rosterRows = useMemo(
    () =>
      [...salaryProfiles].sort(
        (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'zh-CN'),
      ),
    [salaryProfiles],
  )
  const selectedSalaryAccount =
    addableSalaryAccounts.find((profile) => profile.id === salaryAddProfileId) ?? null
  const selectedAddStaff = salaryProfiles.find((row) => row.id === addStaffId) ?? null

  // ---------------- 员工视图：本人工资条 ----------------
  if (!canManage) {
    const myItems = items.filter((item) => item.profile_id === myProfileId)
    if (myItems.length === 0) {
      return (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            暂无已推送的工资条，财务推送后会显示在这里。
          </CardContent>
        </Card>
      )
    }
    return (
      <div className="space-y-6">
        {myItems.map((item) => {
          const itemSheet = sheets.find((entry) => entry.id === item.sheet_id)
          const derived = calcPayroll(item)
          const fields: { label: string; value: string; bold?: boolean }[] = [
            { label: '出勤天数', value: formatAmount(Number(item.attendance_days)) },
            { label: '基本工资', value: formatCny(Number(item.base_salary)) },
            { label: '提成', value: formatCny(Number(item.commission)) },
            { label: '奖金', value: formatCny(Number(item.bonus)) },
            { label: '考勤扣款', value: formatCny(Number(item.attendance_deduction)) },
            { label: '应发工资', value: formatCny(derived.gross), bold: true },
            { label: '其他扣款', value: formatCny(Number(item.other_deduction)) },
            { label: '社保代扣', value: formatCny(Number(item.social_insurance)) },
            { label: '公积金代扣', value: formatCny(Number(item.housing_fund)) },
            { label: '个税扣款', value: formatCny(Number(item.tax)) },
            { label: '应扣工资', value: formatCny(derived.totalDeduction), bold: true },
            { label: '实发工资', value: formatCny(derived.net), bold: true },
          ]
          if (item.remark) fields.push({ label: '备注', value: item.remark })
          return (
            <Card key={item.id}>
              <CardContent className="space-y-4 pt-6">
                <div className="font-medium">
                  {itemSheet ? `${monthLabel(itemSheet.period_month)}工资条` : '工资条'}
                  {itemSheet?.payout_month
                    ? `（${monthLabel(itemSheet.payout_month)}发放）`
                    : ''}
                </div>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableBody>
                      {fields.map((field) => (
                        <TableRow key={field.label}>
                          <TableCell className="w-40 text-muted-foreground">
                            {field.label}
                          </TableCell>
                          <TableCell
                            className={
                              field.bold ? 'text-right font-semibold' : 'text-right'
                            }
                          >
                            {field.value}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    )
  }

  // ---------------- 财务/管理员视图 ----------------
  // 无账号人员没有员工端，工资条默认不推送，只保留在工资表里
  const pushedItems = sheetItems.filter((item) => item.pushed_at)
  const pendingPushCount = sheetItems.filter((item) => item.profile_id && !item.pushed_at).length
  const noAccountCount = sheetItems.filter((item) => !item.profile_id).length
  const totals = sheetItems.reduce(
    (acc, item) => {
      const draft = drafts[item.id]
      const derived = draft ? calcPayroll(draftPayrollValues(draft)) : calcPayroll(item)
      return {
        base: acc.base + (draft ? Number(draft.base_salary || 0) : Number(item.base_salary)),
        commission:
          acc.commission + (draft ? Number(draft.commission || 0) : Number(item.commission)),
        bonus: acc.bonus + (draft ? Number(draft.bonus || 0) : Number(item.bonus)),
        attendanceDeduction:
          acc.attendanceDeduction +
          (draft ? Number(draft.attendance_deduction || 0) : Number(item.attendance_deduction)),
        otherDeduction:
          acc.otherDeduction +
          (draft ? Number(draft.other_deduction || 0) : Number(item.other_deduction)),
        social:
          acc.social +
          (draft ? Number(draft.social_insurance || 0) : Number(item.social_insurance)),
        fund:
          acc.fund + (draft ? Number(draft.housing_fund || 0) : Number(item.housing_fund)),
        tax: acc.tax + (draft ? Number(draft.tax || 0) : Number(item.tax)),
        gross: acc.gross + derived.gross,
        deduction: acc.deduction + derived.totalDeduction,
        net: acc.net + derived.net,
      }
    },
    {
      base: 0,
      commission: 0,
      bonus: 0,
      attendanceDeduction: 0,
      otherDeduction: 0,
      social: 0,
      fund: 0,
      tax: 0,
      gross: 0,
      deduction: 0,
      net: 0,
    },
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={currentMonth || undefined}
          disabled={editing}
          onValueChange={(value) => {
            setCurrentMonth(value)
            setAddStaffId('')
            setManualStaffName('')
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="选择工资表" />
          </SelectTrigger>
          <SelectContent>
            {sheets.map((entry) => (
              <SelectItem key={entry.id} value={entry.period_month}>
                {monthLabel(entry.period_month)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canManage && (
          <>
            <Button
              variant="outline"
              onClick={() => {
                setCreatePeriod('')
                setCreatePayout('')
                setCreateOpen(true)
              }}
            >
              新建工资表
            </Button>
            <Button variant="outline" onClick={openSalaryDialog}>
              薪资档案
            </Button>
          </>
        )}
        {sheet && (
          <>
            <Badge variant={sheet.status === 'published' ? 'default' : 'secondary'}>
              {PAYROLL_SHEET_STATUS_LABELS[sheet.status]}
            </Badge>
            {sheet.status === 'published' && (
              <span className="text-xs text-muted-foreground">
                已推送 {pushedItems.length} 人
                {pendingPushCount > 0 ? ` · 待推送 ${pendingPushCount} 人` : ''}
                {noAccountCount > 0 ? ` · 无账号 ${noAccountCount} 人` : ''}
              </span>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {editing ? (
                <>
                  <Button onClick={handleSaveRows} disabled={pending || dirtyIds.length === 0}>
                    保存修改{dirtyIds.length > 0 ? `（${dirtyIds.length} 行）` : ''}
                  </Button>
                  <Button variant="outline" disabled={pending} onClick={requestCancelEditing}>
                    取消编辑
                  </Button>
                </>
              ) : (
                <Button variant="outline" disabled={pending} onClick={() => setEditing(true)}>
                  编辑工资表
                </Button>
              )}
              {sheet.status === 'draft' && !editing && (
                <>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => setPublishOpen(true)}
                  >
                    推送工资条
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={pending}
                    onClick={() => setDeleteOpen(true)}
                  >
                    删除工资表
                  </Button>
                </>
              )}
              {sheet.status === 'published' && !editing && (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => setUnpublishOpen(true)}
                >
                  撤回发布
                </Button>
              )}
            </div>
          </>
        )}
      </div>

      {sheet && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {canManage && (
            <>
              <Label htmlFor="payout_month" className="text-muted-foreground">
                发放月份
              </Label>
              <Input
                id="payout_month"
                type="month"
                className="w-40"
                disabled={locked || !editing}
                value={toMonthInputValue(sheet.payout_month)}
                onChange={(event) =>
                  runAction(() =>
                    updatePayrollSheetMeta({
                      sheet_id: sheet.id,
                      payout_month: fromMonthInputValue(event.target.value),
                    }),
                  )
                }
              />
              <Label htmlFor="full_attendance_days" className="text-muted-foreground">
                满勤天数
              </Label>
              <Input
                id="full_attendance_days"
                type="number"
                min={1}
                max={31}
                className="h-8 w-20 text-right"
                disabled={locked || !editing}
                value={effectiveFullDays}
                onChange={(event) => handleFullDaysChange(event.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                {locked
                  ? '已推送后满勤天数锁定；单行改数请先撤回该员工，改完再单独推送。'
                  : editing
                    ? '默认当月工作日数；考勤扣款=底薪÷满勤天数×缺勤天数，手动改过的行不联动。'
                    : '发放月份与满勤天数随整表编辑一起解锁，点「编辑工资表」后可调整。'}
              </span>
            </>
          )}
          {sheet.status === 'published' && sheet.published_at && (
            <span className="text-xs text-muted-foreground">
              推送于 {formatDate(sheet.published_at, true)}
            </span>
          )}
        </div>
      )}

      {sheet && canManage && (
        <p className="text-xs text-muted-foreground">
          {locked
            ? '已推送的工资条只读；点某行「撤回」后该员工看不到工资条，改完点该行「推送」即可重新送达。'
            : editing
              ? '正在编辑：金额与天数改动点「保存修改」统一生效；补入/移除人员立即保存；点「取消编辑」放弃未保存的金额与天数。'
              : '工资表默认只读，点「编辑工资表」后才能修改人员与金额。'}
        </p>
      )}

      {!sheet ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {canManage
              ? '还没有工资表，点击右上角「新建工资表」开始核算。'
              : '暂无工资表。'}
          </CardContent>
        </Card>
      ) : (
        <>
          {sheet.status === 'draft' && editing && (
            <div className="flex flex-wrap items-center gap-2">
              <Popover open={addStaffOpen} onOpenChange={setAddStaffOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-64 justify-between font-normal"
                    disabled={pending || addableStaff.length === 0}
                  >
                    <span className={cn('truncate', !selectedAddStaff && 'text-muted-foreground')}>
                      {selectedAddStaff
                        ? payrollStaffLabel(selectedAddStaff)
                        : addableStaff.length === 0
                          ? '薪资档案人员已全部在本表'
                          : '选择薪资档案人员…'}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-[--radix-popover-trigger-width] min-w-[280px] p-0"
                  align="start"
                >
                  <Command>
                    <CommandInput placeholder="搜索姓名…" />
                    <CommandList>
                      <CommandEmpty>未找到人员</CommandEmpty>
                      <CommandGroup>
                        {addableStaff.map((row) => (
                          <CommandItem
                            key={row.id}
                            value={payrollStaffLabel(row)}
                            onSelect={() => {
                              setAddStaffId(row.id)
                              setAddStaffOpen(false)
                            }}
                          >
                            <Check
                              className={cn(
                                'mr-2 h-4 w-4 shrink-0',
                                addStaffId === row.id ? 'opacity-100' : 'opacity-0',
                              )}
                            />
                            <span className="truncate">{payrollStaffLabel(row)}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <Button
                variant="outline"
                size="sm"
                disabled={pending || !addStaffId}
                onClick={() => handleAddStaff(addStaffId)}
              >
                补入员工
              </Button>
              <span className="text-xs text-muted-foreground">或手动新增无账号员工</span>
              <Input
                className="h-8 w-40"
                maxLength={50}
                placeholder="员工姓名"
                value={manualStaffName}
                onChange={(event) => setManualStaffName(event.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={pending || !manualStaffName.trim()}
                onClick={handleAddManualStaff}
              >
                新增并补入
              </Button>
              <span className="text-xs text-muted-foreground">
                手动新增会同时写入薪资档案，后续新建工资表继续带入。
              </span>
            </div>
          )}
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">序号</TableHead>
                  <TableHead>员工姓名</TableHead>
                  <TableHead className="text-right">出勤天数</TableHead>
                  <TableHead className="text-right">基本工资</TableHead>
                  <TableHead className="text-right">提成</TableHead>
                  <TableHead className="text-right">奖金</TableHead>
                  <TableHead className="text-right">考勤扣款</TableHead>
                  <TableHead className="text-right">应发工资</TableHead>
                  <TableHead className="text-right">其他扣款</TableHead>
                  <TableHead className="text-right">社保代扣</TableHead>
                  <TableHead className="text-right">公积金代扣</TableHead>
                  <TableHead className="text-right">个税扣款</TableHead>
                  <TableHead className="text-right">应扣工资</TableHead>
                  <TableHead className="text-right">实发工资</TableHead>
                  <TableHead className="min-w-32">备注</TableHead>
                  {sheet.status === 'published' && <TableHead>推送状态</TableHead>}
                  {sheet.status === 'draft' && editing && <TableHead className="w-10" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sheetItems.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={
                        15 +
                        (sheet.status === 'published' ? 1 : 0) +
                        (sheet.status === 'draft' && editing ? 1 : 0)
                      }
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      {canManage
                        ? '暂无人员。点「编辑工资表」后可从薪资档案补入，或先在「薪资档案」新增人员。'
                        : '暂无工资明细。'}
                    </TableCell>
                  </TableRow>
                )}
                {sheetItems.map((item, index) => {
                  const draft = drafts[item.id]
                  const derived = draft ? calcPayroll(draftPayrollValues(draft)) : calcPayroll(item)
                  return (
                    <TableRow key={item.id}>
                      <TableCell>{index + 1}</TableCell>
                      <TableCell className="whitespace-nowrap font-medium">
                        {payrollItemName(item)}
                        {!item.profile_id && (
                          <Badge variant="outline" className="ml-2 font-normal">
                            无账号
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="p-1">
                        <Input
                          type="number"
                          min="0"
                          max="62"
                          step="0.01"
                          className="h-8 w-20 text-right"
                          disabled={!editing || rowLocked(item)}
                          value={draft?.attendance_days ?? ''}
                          onChange={(event) =>
                            patchDraft(item.id, 'attendance_days', event.target.value)
                          }
                        />
                      </TableCell>
                      {(
                        [
                          ['base_salary', '基本工资'],
                          ['commission', '提成'],
                          ['bonus', '奖金'],
                          ['attendance_deduction', '考勤扣款'],
                        ] as const
                      ).map(([field, label]) => (
                        <TableCell key={field} className="p-1">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            aria-label={`${payrollItemName(item)}${label}`}
                            className="h-8 w-24 text-right"
                            disabled={!editing || rowLocked(item)}
                            value={draft?.[field] ?? ''}
                            onChange={(event) => patchDraft(item.id, field, event.target.value)}
                          />
                        </TableCell>
                      ))}
                      <TableCell className="whitespace-nowrap text-right font-medium">
                        {formatCny(derived.gross)}
                      </TableCell>
                      {(
                        [
                          ['other_deduction', '其他扣款'],
                          ['social_insurance', '社保代扣'],
                          ['housing_fund', '公积金代扣'],
                          ['tax', '个税扣款'],
                        ] as const
                      ).map(([field, label]) => (
                        <TableCell key={field} className="p-1">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            aria-label={`${payrollItemName(item)}${label}`}
                            className="h-8 w-24 text-right"
                            disabled={!editing || rowLocked(item)}
                            value={draft?.[field] ?? ''}
                            onChange={(event) => patchDraft(item.id, field, event.target.value)}
                          />
                        </TableCell>
                      ))}
                      <TableCell className="whitespace-nowrap text-right font-medium">
                        {formatCny(derived.totalDeduction)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-semibold">
                        {formatCny(derived.net)}
                      </TableCell>
                      <TableCell className="p-1">
                        <Input
                          className="h-8 min-w-28"
                          maxLength={500}
                          disabled={!editing || rowLocked(item)}
                          value={draft?.remark ?? ''}
                          onChange={(event) => patchDraft(item.id, 'remark', event.target.value)}
                        />
                      </TableCell>
                      {sheet.status === 'published' && (
                        <TableCell>
                          {!item.profile_id ? (
                            <Badge variant="outline">未推送（无账号）</Badge>
                          ) : item.pushed_at ? (
                            <div className="flex items-center gap-1">
                              <Badge>已推送</Badge>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={pending}
                                onClick={() => handleUnpushItem(item)}
                              >
                                撤回
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1">
                              <Badge variant="secondary">未推送</Badge>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={pending}
                                onClick={() => handlePushItem(item)}
                              >
                                推送
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      )}
                      {sheet.status === 'draft' && editing && (
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => setRemoveTarget(item)}
                          >
                            移除
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  )
                })}
                <TableRow className="border-t-2 font-medium">
                  <TableCell />
                  <TableCell>合计</TableCell>
                  <TableCell />
                  <TableCell className="text-right">{formatCny(totals.base)}</TableCell>
                  <TableCell className="text-right">{formatCny(totals.commission)}</TableCell>
                  <TableCell className="text-right">{formatCny(totals.bonus)}</TableCell>
                  <TableCell className="text-right">
                    {formatCny(totals.attendanceDeduction)}
                  </TableCell>
                  <TableCell className="text-right">{formatCny(totals.gross)}</TableCell>
                  <TableCell className="text-right">{formatCny(totals.otherDeduction)}</TableCell>
                  <TableCell className="text-right">{formatCny(totals.social)}</TableCell>
                  <TableCell className="text-right">{formatCny(totals.fund)}</TableCell>
                  <TableCell className="text-right">{formatCny(totals.tax)}</TableCell>
                  <TableCell className="text-right">{formatCny(totals.deduction)}</TableCell>
                  <TableCell className="text-right">{formatCny(totals.net)}</TableCell>
                  <TableCell
                    colSpan={
                      1 +
                      (sheet.status === 'published' ? 1 : 0) +
                      (sheet.status === 'draft' && editing ? 1 : 0)
                    }
                  />
                </TableRow>
              </TableBody>
            </Table>
          </div>
          {sheet.status === 'published' && (
            <p className="text-xs text-muted-foreground">
              已推送的工资条金额只读。个别有误可只「撤回」该员工，改数后单独「推送」；整表重来才用「撤回发布」。
            </p>
          )}
        </>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建工资表</DialogTitle>
            <DialogDescription>
              按所属月份创建，默认带入薪资档案中的全部人员（含没有系统账号的员工），
              并按档案底薪/社保/公积金、考勤表出勤天数、员工已确认结清提成自动填入；
              满勤天数默认当月工作日数，所有金额仍可逐项手动修改。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="payroll_period_month">所属月份（必填）</Label>
              <Input
                id="payroll_period_month"
                type="month"
                value={createPeriod}
                onChange={(event) => setCreatePeriod(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="payroll_payout_month">发放月份（可选）</Label>
              <Input
                id="payroll_payout_month"
                type="month"
                value={createPayout}
                onChange={(event) => setCreatePayout(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button disabled={pending || !createPeriod} onClick={handleCreate}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={salaryOpen} onOpenChange={setSalaryOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>薪资档案</DialogTitle>
            <DialogDescription>
              薪资档案是新建工资表的人员来源：可加入系统账号员工，也可直接填写没有账号的员工姓名。
              新建工资表或补入员工时自动带入底薪、社保代扣、公积金代扣；从档案移除不影响已生成的工资表。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Popover open={salaryAddOpen} onOpenChange={setSalaryAddOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="w-56 justify-between font-normal"
                  disabled={pending || addableSalaryAccounts.length === 0}
                >
                  <span className={cn('truncate', !selectedSalaryAccount && 'text-muted-foreground')}>
                    {selectedSalaryAccount
                      ? displayProfileName(selectedSalaryAccount)
                      : addableSalaryAccounts.length === 0
                        ? '有账号员工已全部在档案中'
                        : '选择系统账号员工…'}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-[--radix-popover-trigger-width] min-w-[240px] p-0"
                align="start"
              >
                <Command>
                  <CommandInput placeholder="搜索姓名…" />
                  <CommandList>
                    <CommandEmpty>未找到员工</CommandEmpty>
                    <CommandGroup>
                      {addableSalaryAccounts.map((profile) => (
                        <CommandItem
                          key={profile.id}
                          value={displayProfileName(profile)}
                          onSelect={() => {
                            setSalaryAddProfileId(profile.id)
                            setSalaryAddOpen(false)
                          }}
                        >
                          <Check
                            className={cn(
                              'mr-2 h-4 w-4 shrink-0',
                              salaryAddProfileId === profile.id ? 'opacity-100' : 'opacity-0',
                            )}
                          />
                          <span className="truncate">{displayProfileName(profile)}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <Button
              variant="outline"
              size="sm"
              disabled={pending || !salaryAddProfileId}
              onClick={handleAddSalaryAccount}
            >
              加入档案
            </Button>
            <span className="text-xs text-muted-foreground">或手动添加无账号员工</span>
            <Input
              className="h-8 w-36"
              maxLength={50}
              placeholder="员工姓名"
              value={salaryManualName}
              onChange={(event) => setSalaryManualName(event.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={pending || !salaryManualName.trim()}
              onClick={handleAddSalaryManual}
            >
              添加人员
            </Button>
          </div>
          <div className="max-h-[55vh] overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>员工姓名</TableHead>
                  <TableHead className="text-right">底薪</TableHead>
                  <TableHead className="text-right">社保代扣</TableHead>
                  <TableHead className="text-right">公积金代扣</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rosterRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                      档案里还没有人，先在上方加入员工。
                    </TableCell>
                  </TableRow>
                )}
                {rosterRows.map((row) => {
                  const draft = salaryDrafts[row.id]
                  if (!draft) return null
                  const isAccount = Boolean(row.profile_id)
                  const dirty =
                    draft.name !== row.name ||
                    draft.base_salary !== draftValue(row.base_salary) ||
                    draft.social_insurance !== draftValue(row.social_insurance) ||
                    draft.housing_fund !== draftValue(row.housing_fund)
                  const patch = (field: keyof SalaryDraft, value: string) =>
                    setSalaryDrafts((current) => ({
                      ...current,
                      [row.id]: { ...draft, [field]: value },
                    }))
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="p-1">
                        {isAccount ? (
                          <div className="flex items-center gap-2 px-2">
                            <span className="whitespace-nowrap font-medium">{row.name}</span>
                            <Badge variant="outline">账号</Badge>
                          </div>
                        ) : (
                          <Input
                            className="h-8 w-36"
                            maxLength={50}
                            aria-label="员工姓名"
                            value={draft.name}
                            onChange={(event) => patch('name', event.target.value)}
                          />
                        )}
                      </TableCell>
                      {(
                        [
                          ['base_salary', '底薪'],
                          ['social_insurance', '社保代扣'],
                          ['housing_fund', '公积金代扣'],
                        ] as const
                      ).map(([field, label]) => (
                        <TableCell key={field} className="p-1">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            aria-label={`${row.name}${label}`}
                            className="h-8 w-24 text-right"
                            value={draft[field]}
                            onChange={(event) => patch(field, event.target.value)}
                          />
                        </TableCell>
                      ))}
                      <TableCell className="p-1">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              pending ||
                              !dirty ||
                              (!isAccount && !draft.name.trim())
                            }
                            onClick={() =>
                              runAction(() =>
                                savePayrollSalaryProfile({
                                  id: row.id,
                                  name: draft.name.trim(),
                                  base_salary: Number(draft.base_salary || 0),
                                  social_insurance: Number(draft.social_insurance || 0),
                                  housing_fund: Number(draft.housing_fund || 0),
                                }),
                              )
                            }
                          >
                            保存
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => setSalaryDeleteTarget(row)}
                          >
                            删除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSalaryOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={salaryDeleteTarget !== null}
        onOpenChange={(open) => !open && setSalaryDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>从薪资档案移除</DialogTitle>
            <DialogDescription>
              移除 {salaryDeleteTarget?.name ?? ''} 后，新建工资表不再带入该人员；
              已生成的工资表保留姓名与金额快照，不受影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSalaryDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" disabled={pending} onClick={handleDeleteSalaryProfile}>
              确认移除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>推送工资条</DialogTitle>
            <DialogDescription>
              推送后员工可在「工资表」页查看本人工资条，每人只能看到自己的；无系统账号的人员不推送。金额随即锁定，个别有误可只撤回该员工，改完再单独推送。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishOpen(false)}>
              再想想
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                setPublishOpen(false)
                runAction(() => publishPayrollSheet({ sheet_id: sheet?.id ?? '' }))
              }}
            >
              确认推送
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={unpublishOpen} onOpenChange={setUnpublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>撤回发布</DialogTitle>
            <DialogDescription>
              撤回后工资表回到草稿、可重新修改金额；重新推送后员工才能再次看到工资条。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnpublishOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                setUnpublishOpen(false)
                runAction(() => unpublishPayrollSheet({ sheet_id: sheet?.id ?? '' }))
              }}
            >
              确认撤回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除工资表</DialogTitle>
            <DialogDescription>
              仅草稿可删除，删除后该月全部工资明细一并清除，不可恢复。
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
                runAction(() => deletePayrollSheet({ sheet_id: sheet?.id ?? '' }))
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>放弃未保存的修改</DialogTitle>
            <DialogDescription>
              当前有 {dirtyIds.length} 行金额或天数尚未保存，取消编辑将丢弃这些改动；已补入/移除的人员不受影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscardOpen(false)}>
              继续编辑
            </Button>
            <Button variant="destructive" onClick={cancelEditing}>
              放弃修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移除员工</DialogTitle>
            <DialogDescription>
              从本表移除「
              {removeTarget
                ? removeTarget.profile
                  ? displayProfileName(removeTarget.profile)
                  : removeTarget.employee_name
                : ''}
              」后，该行已填金额一并删除；人员仍在薪资档案中，可通过「补入员工」重新加入。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" disabled={pending} onClick={handleRemoveItem}>
              确认移除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
