'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import {
  addPayrollItem,
  confirmOwnPayrollItem,
  createPayrollSheet,
  deletePayrollSheet,
  publishPayrollSheet,
  rejectOwnPayrollItem,
  removePayrollItem,
  savePayrollSalaryProfile,
  updatePayrollItems,
  updatePayrollSheetMeta,
} from '@/lib/actions/payroll'
import {
  calcAttendanceDeduction,
  calcPayroll,
  countWeekdays,
  PAYROLL_CONFIRMATION_LABELS,
  PAYROLL_SHEET_STATUS_LABELS,
} from '@/lib/payroll'
import { formatCny } from '@/lib/finance'
import { displayProfileName, formatAmount, formatDate } from '@/lib/utils'
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

function monthLabel(month: string) {
  return `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`
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
  const [salaryOpen, setSalaryOpen] = useState(false)
  const [salaryDrafts, setSalaryDrafts] = useState<
    Record<string, { base_salary: string; social_insurance: string; housing_fund: string }>
  >({})
  const [pending, startTransition] = useTransition()
  const [createOpen, setCreateOpen] = useState(false)
  const [createPeriod, setCreatePeriod] = useState('')
  const [createPayout, setCreatePayout] = useState('')
  const [publishOpen, setPublishOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [rejectTarget, setRejectTarget] = useState<PayrollItemWithProfile | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [addProfileId, setAddProfileId] = useState('')

  const sheet = sheets.find((entry) => entry.period_month === currentMonth) ?? null
  const sheetItems = useMemo(
    () => items.filter((item) => item.sheet_id === sheet?.id),
    [items, sheet?.id],
  )
  const effectiveFullDays =
    fullDaysOverride ?? sheet?.full_attendance_days ?? countWeekdays(currentMonth.slice(0, 7))

  const deductionTouchedRef = useRef<Record<string, boolean>>({})
  deductionTouchedRef.current = deductionTouched

  useEffect(() => {
    const next: Record<string, RowDraft> = {}
    const fullDays = fullDaysOverride ?? sheet?.full_attendance_days ?? null
    for (const item of items) {
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
    .filter((item) => drafts[item.id] && isDirty(item, drafts[item.id]))
    .map((item) => item.id)

  function patchDraft(itemId: string, field: keyof RowDraft, value: string) {
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
    if (!sheet) return
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
    const next: Record<string, { base_salary: string; social_insurance: string; housing_fund: string }> = {}
    for (const profile of profiles) {
      const salary = salaryProfiles.find((row) => row.profile_id === profile.id)
      next[profile.id] = {
        base_salary: salary ? String(Number(salary.base_salary)) : '',
        social_insurance: salary ? String(Number(salary.social_insurance)) : '',
        housing_fund: salary ? String(Number(salary.housing_fund)) : '',
      }
    }
    setSalaryDrafts(next)
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
        toast.success('工资表已创建，已默认带入全部在职员工')
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
    runAction(() => updatePayrollItems({ rows }))
  }

  const addableProfiles = profiles.filter(
    (profile) => !sheetItems.some((item) => item.profile_id === profile.id),
  )

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
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">
                    {itemSheet ? `${monthLabel(itemSheet.period_month)}工资条` : '工资条'}
                    {itemSheet?.payout_month
                      ? `（${monthLabel(itemSheet.payout_month)}发放）`
                      : ''}
                  </div>
                  <Badge
                    variant={
                      item.confirmation === 'confirmed'
                        ? 'default'
                        : item.confirmation === 'rejected'
                          ? 'destructive'
                          : 'secondary'
                    }
                  >
                    {PAYROLL_CONFIRMATION_LABELS[item.confirmation]}
                  </Badge>
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
                {item.confirmation === 'rejected' && item.rejected_reason && (
                  <p className="text-sm text-destructive">
                    驳回原因：{item.rejected_reason}（财务修改后会重新回到待确认）
                  </p>
                )}
                {item.confirmation === 'pending' && (
                  <div className="flex gap-2">
                    <Button
                      disabled={pending}
                      onClick={() =>
                        runAction(() => confirmOwnPayrollItem({ item_id: item.id }))
                      }
                    >
                      确认无误
                    </Button>
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => {
                        setRejectReason('')
                        setRejectTarget(item)
                      }}
                    >
                      驳回
                    </Button>
                  </div>
                )}
                {item.confirmation === 'confirmed' && item.confirmed_at && (
                  <p className="text-xs text-muted-foreground">
                    已于 {formatDate(item.confirmed_at, true)} 确认
                  </p>
                )}
              </CardContent>
            </Card>
          )
        })}
        <Dialog open={rejectTarget !== null} onOpenChange={(open) => !open && setRejectTarget(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>驳回工资条</DialogTitle>
              <DialogDescription>
                请填写驳回原因，财务修改后会重新推送确认。
              </DialogDescription>
            </DialogHeader>
            <Textarea
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              maxLength={500}
              placeholder="例如：提成金额与预期不符"
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setRejectTarget(null)}>
                取消
              </Button>
              <Button
                variant="destructive"
                disabled={pending || !rejectReason.trim()}
                onClick={() => {
                  if (!rejectTarget) return
                  const target = rejectTarget
                  setRejectTarget(null)
                  runAction(() =>
                    rejectOwnPayrollItem({ item_id: target.id, reason: rejectReason.trim() }),
                  )
                }}
              >
                确认驳回
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    )
  }

  // ---------------- 财务/管理员视图 ----------------
  const confirmedCount = sheetItems.filter((item) => item.confirmation === 'confirmed').length
  const rejectedCount = sheetItems.filter((item) => item.confirmation === 'rejected').length
  const pendingCount = sheetItems.length - confirmedCount - rejectedCount
  const totals = sheetItems.reduce(
    (acc, item) => {
      const derived = calcPayroll(item)
      return {
        base: acc.base + Number(item.base_salary),
        commission: acc.commission + Number(item.commission),
        bonus: acc.bonus + Number(item.bonus),
        attendanceDeduction:
          acc.attendanceDeduction + Number(item.attendance_deduction),
        otherDeduction: acc.otherDeduction + Number(item.other_deduction),
        social: acc.social + Number(item.social_insurance),
        fund: acc.fund + Number(item.housing_fund),
        tax: acc.tax + Number(item.tax),
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
          onValueChange={(value) => {
            setCurrentMonth(value)
            setAddProfileId('')
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
                已确认 {confirmedCount} / 待确认 {pendingCount} / 已驳回 {rejectedCount}
              </span>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {dirtyIds.length > 0 && (
                <Button onClick={handleSaveRows} disabled={pending}>
                  保存修改（{dirtyIds.length} 行）
                </Button>
              )}
              {sheet.status === 'draft' && (
                <>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => setPublishOpen(true)}
                  >
                    推送员工确认
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
                value={effectiveFullDays}
                onChange={(event) => handleFullDaysChange(event.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                默认当月工作日数；考勤扣款=底薪÷满勤天数×缺勤天数，手动改过的行不联动。
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
          {sheet.status === 'draft' && addableProfiles.length > 0 && (
            <div className="flex items-center gap-2">
              <Select value={addProfileId || undefined} onValueChange={setAddProfileId}>
                <SelectTrigger className="w-52">
                  <SelectValue placeholder="选择要补入的员工" />
                </SelectTrigger>
                <SelectContent>
                  {addableProfiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {displayProfileName(profile)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                disabled={pending || !addProfileId}
                onClick={() =>
                  runAction(() =>
                    addPayrollItem({ sheet_id: sheet.id, profile_id: addProfileId }),
                  )
                }
              >
                补入员工
              </Button>
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
                  {sheet.status === 'published' && <TableHead>确认状态</TableHead>}
                  {sheet.status === 'draft' && <TableHead className="w-10" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sheetItems.map((item, index) => {
                  const draft = drafts[item.id]
                  const derived = draft
                    ? calcPayroll({
                        base_salary: Number(draft.base_salary || 0),
                        commission: Number(draft.commission || 0),
                        bonus: Number(draft.bonus || 0),
                        attendance_deduction: Number(draft.attendance_deduction || 0),
                        other_deduction: Number(draft.other_deduction || 0),
                        social_insurance: Number(draft.social_insurance || 0),
                        housing_fund: Number(draft.housing_fund || 0),
                        tax: Number(draft.tax || 0),
                      })
                    : calcPayroll(item)
                  return (
                    <TableRow key={item.id}>
                      <TableCell>{index + 1}</TableCell>
                      <TableCell className="whitespace-nowrap font-medium">
                        {displayProfileName(item.profile)}
                      </TableCell>
                      <TableCell className="p-1">
                        <Input
                          type="number"
                          min="0"
                          max="62"
                          step="0.5"
                          className="h-8 w-20 text-right"
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
                            aria-label={`${displayProfileName(item.profile)}${label}`}
                            className="h-8 w-24 text-right"
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
                            aria-label={`${displayProfileName(item.profile)}${label}`}
                            className="h-8 w-24 text-right"
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
                          value={draft?.remark ?? ''}
                          onChange={(event) => patchDraft(item.id, 'remark', event.target.value)}
                        />
                      </TableCell>
                      {sheet.status === 'published' && (
                        <TableCell>
                          <div className="space-y-1">
                            <Badge
                              variant={
                                item.confirmation === 'confirmed'
                                  ? 'default'
                                  : item.confirmation === 'rejected'
                                    ? 'destructive'
                                    : 'secondary'
                              }
                            >
                              {PAYROLL_CONFIRMATION_LABELS[item.confirmation]}
                            </Badge>
                            {item.confirmation === 'rejected' && item.rejected_reason && (
                              <p className="max-w-36 truncate text-xs text-muted-foreground">
                                {item.rejected_reason}
                              </p>
                            )}
                          </div>
                        </TableCell>
                      )}
                      {sheet.status === 'draft' && (
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() =>
                              runAction(() => removePayrollItem({ item_id: item.id }))
                            }
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
                  <TableCell colSpan={sheet.status === 'published' ? 2 : 1} />
                </TableRow>
              </TableBody>
            </Table>
          </div>
          {sheet.status === 'published' && (
            <p className="text-xs text-muted-foreground">
              已推送的工资表仍可修改金额，修改后该员工自动回到待确认。
            </p>
          )}
        </>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建工资表</DialogTitle>
            <DialogDescription>
              按所属月份创建，自动带入全部在职员工，并按薪资档案（底薪/社保/公积金）、考勤表出勤天数、
              员工已确认结清提成自动填入；满勤天数默认当月工作日数，所有金额仍可逐项手动修改。
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
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>薪资档案</DialogTitle>
            <DialogDescription>
              维护每人的底薪、社保代扣、公积金代扣；新建工资表或补入员工时自动带入，工资表内改动不回写档案。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>员工姓名</TableHead>
                  <TableHead className="text-right">底薪</TableHead>
                  <TableHead className="text-right">社保代扣</TableHead>
                  <TableHead className="text-right">公积金代扣</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {profiles.map((profile) => {
                  const draft = salaryDrafts[profile.id]
                  if (!draft) return null
                  const salary = salaryProfiles.find((row) => row.profile_id === profile.id)
                  const dirty =
                    !salary ||
                    draft.base_salary !== String(Number(salary.base_salary)) ||
                    draft.social_insurance !== String(Number(salary.social_insurance)) ||
                    draft.housing_fund !== String(Number(salary.housing_fund))
                  const patch = (field: keyof typeof draft, value: string) =>
                    setSalaryDrafts((current) => ({
                      ...current,
                      [profile.id]: { ...draft, [field]: value },
                    }))
                  return (
                    <TableRow key={profile.id}>
                      <TableCell className="whitespace-nowrap font-medium">
                        {displayProfileName(profile)}
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
                            aria-label={`${displayProfileName(profile)}${label}`}
                            className="h-8 w-24 text-right"
                            value={draft[field]}
                            onChange={(event) => patch(field, event.target.value)}
                          />
                        </TableCell>
                      ))}
                      <TableCell className="p-1">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending || !dirty}
                          onClick={() =>
                            runAction(() =>
                              savePayrollSalaryProfile({
                                profile_id: profile.id,
                                base_salary: Number(draft.base_salary || 0),
                                social_insurance: Number(draft.social_insurance || 0),
                                housing_fund: Number(draft.housing_fund || 0),
                              }),
                            )
                          }
                        >
                          保存
                        </Button>
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

      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>推送员工确认</DialogTitle>
            <DialogDescription>
              推送后员工可在「工资表」页查看本人工资条并确认或驳回；此后修改金额会自动回到待确认。
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
    </div>
  )
}
