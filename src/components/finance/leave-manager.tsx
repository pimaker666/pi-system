'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
  createLeaveRequest,
  reviewLeaveRequest,
  updateLeaveRequest,
  withdrawLeaveRequest,
} from '@/lib/actions/leave'
import {
  daysBetweenInclusive,
  formatLeaveHours,
  isValidHourlyLeave,
  LEAVE_DAY_PART_LABELS,
  LEAVE_STATUS_LABELS,
  LEAVE_TYPE_META,
  MAX_HOURLY_LEAVE,
  type LeaveHalf,
} from '@/lib/leave'
import { displayProfileName } from '@/lib/utils'
import type { LeaveDayPart, LeaveRequestWithProfile, LeaveType } from '@/types'

const HOURS_OPTIONS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5]

function durationLabel(request: LeaveRequestWithProfile) {
  if (request.hours != null) {
    const half = request.day_part === 'afternoon' ? '下午' : '上午'
    return `${request.start_date}（${half} ${formatLeaveHours(request.hours)}）`
  }
  const days = daysBetweenInclusive(request.start_date, request.end_date)
  const range =
    request.start_date === request.end_date
      ? request.start_date
      : `${request.start_date} ~ ${request.end_date}`
  const part =
    request.day_part === 'full'
      ? `${days.length} 天`
      : `${days.length} 个${LEAVE_DAY_PART_LABELS[request.day_part]}`
  return `${range}（${part}）`
}

export function LeaveManager({
  canManage,
  myProfileId,
  requests,
}: {
  canManage: boolean
  myProfileId: string
  requests: LeaveRequestWithProfile[]
}) {
  const [pending, startTransition] = useTransition()
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<LeaveRequestWithProfile | null>(null)
  const [reviewTarget, setReviewTarget] = useState<LeaveRequestWithProfile | null>(null)
  const [reviewApprove, setReviewApprove] = useState(true)
  const [rejectReason, setRejectReason] = useState('')
  const [leaveType, setLeaveType] = useState<LeaveType>('personal')
  const [leaveUnit, setLeaveUnit] = useState<'day' | 'hour'>('day')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [dayPart, setDayPart] = useState<LeaveDayPart>('full')
  const [hourlyHours, setHourlyHours] = useState(1)
  const [reason, setReason] = useState('')

  function openCreate() {
    setLeaveType('personal')
    setLeaveUnit('day')
    setStartDate('')
    setEndDate('')
    setDayPart('full')
    setHourlyHours(1)
    setReason('')
    setEditTarget(null)
    setCreateOpen(true)
  }

  function openEdit(target: LeaveRequestWithProfile) {
    setLeaveType(target.leave_type)
    setLeaveUnit(target.hours != null ? 'hour' : 'day')
    setStartDate(target.start_date)
    setEndDate(target.end_date)
    setDayPart(target.day_part)
    setHourlyHours(target.hours ?? 1)
    setReason(target.reason ?? '')
    setEditTarget(target)
    setCreateOpen(true)
  }

  function handleUnitChange(unit: 'day' | 'hour') {
    setLeaveUnit(unit)
    if (unit === 'hour') {
      if (dayPart === 'full') setDayPart('morning')
      if (startDate) setEndDate(startDate)
      setHourlyHours((prev) => Math.min(prev, MAX_HOURLY_LEAVE[dayPart === 'afternoon' ? 'afternoon' : 'morning']))
    }
  }

  function handleDayPartChange(value: LeaveDayPart) {
    setDayPart(value)
    if (leaveUnit === 'hour' && value !== 'full') {
      setHourlyHours((prev) => Math.min(prev, MAX_HOURLY_LEAVE[value]))
    }
  }

  function handleStartDateChange(value: string) {
    setStartDate(value)
    if (leaveUnit === 'hour') setEndDate(value)
  }

  function handleSubmit() {
    if (!startDate || (leaveUnit === 'day' && !endDate)) {
      toast.error('请选择开始和结束日期')
      return
    }
    if (leaveUnit === 'hour') {
      if (dayPart === 'full') {
        toast.error('按小时请假请选择上午或下午')
        return
      }
      if (!isValidHourlyLeave(hourlyHours, dayPart)) {
        toast.error('小时假须为 0.5 小时步进，上午不超过 3 小时、下午不超过 3.5 小时')
        return
      }
    }
    if (leaveUnit === 'day' && endDate < startDate) {
      toast.error('结束日期不能早于开始日期')
      return
    }
    if (!reason.trim()) {
      toast.error('请填写请假事由')
      return
    }
    const payload = {
      leave_type: leaveType,
      start_date: startDate,
      end_date: leaveUnit === 'hour' ? startDate : endDate,
      day_part: dayPart,
      hours: leaveUnit === 'hour' ? hourlyHours : null,
      reason: reason.trim(),
    }
    startTransition(async () => {
      const result = editTarget
        ? await updateLeaveRequest({ request_id: editTarget.id, ...payload })
        : await createLeaveRequest(payload)
      if (result.ok) {
        toast.success(editTarget ? '请假单已保存' : '请假单已提交，等待审批')
        setCreateOpen(false)
      } else {
        toast.error(result.error ?? '操作失败')
      }
    })
  }

  function openReview(target: LeaveRequestWithProfile, approve: boolean) {
    setReviewTarget(target)
    setReviewApprove(approve)
    setRejectReason('')
  }

  function handleReview() {
    if (!reviewTarget) return
    if (!reviewApprove && !rejectReason.trim()) {
      toast.error('驳回必须填写原因')
      return
    }
    const target = reviewTarget
    setReviewTarget(null)
    startTransition(async () => {
      const result = await reviewLeaveRequest({
        request_id: target.id,
        approve: reviewApprove,
        reject_reason: reviewApprove ? null : rejectReason.trim(),
      })
      if (result.ok) {
        if (reviewApprove) {
          const parts = [`已批准，写入考勤 ${result.written_days ?? 0} 天`]
          if (result.created_sheets) parts.push(`新建考勤表 ${result.created_sheets} 张`)
          if (result.skipped_cells) parts.push(`跳过已标记 ${result.skipped_cells} 格`)
          toast.success(parts.join('，'))
        } else {
          toast.success('已驳回')
        }
      } else {
        toast.error(result.error ?? '审批失败')
      }
    })
  }

  const hourlyHalf: LeaveHalf = dayPart === 'afternoon' ? 'afternoon' : 'morning'
  const maxHourlyHours = MAX_HOURLY_LEAVE[hourlyHalf]

  return (
    <div className="space-y-4">
      <div>
        <Button onClick={openCreate}>提交请假申请</Button>
      </div>

      {requests.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          暂无请假申请。
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {canManage && <TableHead>申请人</TableHead>}
                <TableHead>类型</TableHead>
                <TableHead>请假时间</TableHead>
                <TableHead>事由</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="w-40">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((request) => (
                <TableRow key={request.id}>
                  {canManage && (
                    <TableCell className="whitespace-nowrap font-medium">
                      {displayProfileName(request.applicant)}
                    </TableCell>
                  )}
                  <TableCell className="whitespace-nowrap">
                    {LEAVE_TYPE_META[request.leave_type].label}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {durationLabel(request)}
                  </TableCell>
                  <TableCell className="max-w-64">
                    <span className="line-clamp-2 text-sm">{request.reason}</span>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <Badge
                        variant={
                          request.status === 'approved'
                            ? 'default'
                            : request.status === 'rejected'
                              ? 'destructive'
                              : 'secondary'
                        }
                      >
                        {LEAVE_STATUS_LABELS[request.status]}
                      </Badge>
                      {request.status === 'rejected' && request.reject_reason && (
                        <p className="max-w-40 truncate text-xs text-muted-foreground">
                          {request.reject_reason}
                        </p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {request.status === 'pending' &&
                        (request.applicant_id === myProfileId ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={pending}
                              onClick={() => openEdit(request)}
                            >
                              修改
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={pending}
                              onClick={() =>
                                startTransition(async () => {
                                  const result = await withdrawLeaveRequest({
                                    request_id: request.id,
                                  })
                                  if (result.ok) toast.success('已撤回')
                                  else toast.error(result.error ?? '撤回失败')
                                })
                              }
                            >
                              撤回
                            </Button>
                          </>
                        ) : canManage ? (
                          <>
                            <Button
                              size="sm"
                              disabled={pending}
                              onClick={() => openReview(request, true)}
                            >
                              批准
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={pending}
                              onClick={() => openReview(request, false)}
                            >
                              驳回
                            </Button>
                          </>
                        ) : null)}
                      {request.status === 'rejected' &&
                        request.applicant_id === myProfileId && (
                          <span className="text-xs text-muted-foreground">可重新提交新申请</span>
                        )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editTarget ? '修改请假申请' : '提交请假申请'}</DialogTitle>
            <DialogDescription>
              审批通过后自动写入考勤表（事假○ / 病假☆ / 年假调休●），不覆盖已标记的考勤格。按小时请假记为 √ 并标注时长，工资按 1 小时 = 1/7.5 天自动扣减。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="leave_type">请假类型</Label>
              <Select
                value={leaveType}
                onValueChange={(value) => setLeaveType(value as LeaveType)}
              >
                <SelectTrigger id="leave_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(LEAVE_TYPE_META) as LeaveType[]).map((type) => (
                    <SelectItem key={type} value={type}>
                      {LEAVE_TYPE_META[type].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="leave_unit">请假单位</Label>
              <Select
                value={leaveUnit}
                onValueChange={(value) => handleUnitChange(value as 'day' | 'hour')}
              >
                <SelectTrigger id="leave_unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">按天 / 半天</SelectItem>
                  <SelectItem value="hour">按小时</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="leave_start">开始日期</Label>
                <Input
                  id="leave_start"
                  type="date"
                  value={startDate}
                  onChange={(event) => handleStartDateChange(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="leave_end">结束日期</Label>
                <Input
                  id="leave_end"
                  type="date"
                  value={leaveUnit === 'hour' ? startDate : endDate}
                  min={startDate || undefined}
                  disabled={leaveUnit === 'hour'}
                  onChange={(event) => setEndDate(event.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="leave_day_part">时段</Label>
                <Select
                  value={dayPart}
                  onValueChange={(value) => handleDayPartChange(value as LeaveDayPart)}
                >
                  <SelectTrigger id="leave_day_part">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {leaveUnit === 'day' && (
                      <SelectItem value="full">{LEAVE_DAY_PART_LABELS.full}</SelectItem>
                    )}
                    <SelectItem value="morning">{LEAVE_DAY_PART_LABELS.morning}</SelectItem>
                    <SelectItem value="afternoon">{LEAVE_DAY_PART_LABELS.afternoon}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {leaveUnit === 'hour' && (
                <div className="grid gap-1.5">
                  <Label htmlFor="leave_hours">请假时长</Label>
                  <Select
                    value={String(hourlyHours)}
                    onValueChange={(value) => setHourlyHours(Number(value))}
                  >
                    <SelectTrigger id="leave_hours">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HOURS_OPTIONS.filter((hours) => hours <= maxHourlyHours).map((hours) => (
                        <SelectItem key={hours} value={String(hours)}>
                          {formatLeaveHours(hours)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    上午上班 3.5 小时、下午上班 4 小时，最多可请 {formatLeaveHours(maxHourlyHours)}。
                  </p>
                </div>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="leave_reason">请假事由</Label>
              <Textarea
                id="leave_reason"
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button disabled={pending} onClick={handleSubmit}>
              {editTarget ? '保存' : '提交'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={reviewTarget !== null}
        onOpenChange={(open) => !open && setReviewTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewApprove ? '批准请假' : '驳回请假'}
            </DialogTitle>
            <DialogDescription>
              {reviewTarget &&
                `${displayProfileName(reviewTarget.applicant)} · ${LEAVE_TYPE_META[reviewTarget.leave_type].label} · ${durationLabel(reviewTarget)}`}
              {reviewApprove && '。批准后对应日期自动写入考勤表。'}
            </DialogDescription>
          </DialogHeader>
          {!reviewApprove && (
            <Textarea
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              maxLength={500}
              placeholder="请填写驳回原因"
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewTarget(null)}>
              取消
            </Button>
            <Button
              variant={reviewApprove ? 'default' : 'destructive'}
              disabled={pending || (!reviewApprove && !rejectReason.trim())}
              onClick={handleReview}
            >
              {reviewApprove ? '确认批准' : '确认驳回'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
