'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRightLeft, UserCheck, UserX } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { handoverUser, setUserDisabled } from '@/lib/actions/users'
import type { Profile } from '@/types'

type AccountUser = Pick<
  Profile,
  'id' | 'email' | 'full_name' | 'chinese_name' | 'role' | 'status'
>

function displayName(user: AccountUser) {
  return user.chinese_name?.trim() || user.full_name?.trim() || user.email
}

export function AccountLifecycleActions({
  user,
  users,
  disabled,
  canDisable,
}: {
  user: AccountUser
  users: AccountUser[]
  disabled: boolean
  canDisable: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [handoverOpen, setHandoverOpen] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const [targetId, setTargetId] = useState('')
  const [reason, setReason] = useState('')
  const [transferCustomers, setTransferCustomers] = useState(true)
  const [transferOpenOrders, setTransferOpenOrders] = useState(true)
  const [disableSource, setDisableSource] = useState(!disabled)

  const candidates = users.filter(
    (candidate) =>
      candidate.id !== user.id &&
      candidate.status === 'approved' &&
      candidate.role !== 'finance',
  )

  function openHandover() {
    setTargetId('')
    setReason('')
    setTransferCustomers(true)
    setTransferOpenOrders(true)
    setDisableSource(!disabled && canDisable)
    setHandoverOpen(true)
  }

  function submitHandover() {
    startTransition(async () => {
      const result = await handoverUser({
        sourceUserId: user.id,
        targetUserId: targetId,
        transferCustomers,
        transferOpenOrders,
        disableSource,
        reason,
      })
      if (!result.ok) {
        toast.error(result.error ?? '交接失败')
        return
      }

      const summary = result.summary
      toast.success(
        summary
          ? `交接完成：客户 ${summary.customer_count} 个，业务订单 ${summary.business_order_count} 个，每日订单 ${summary.daily_order_count} 行，自动取消待审改单 ${summary.cancelled_change_request_count} 条`
          : '交接完成',
      )
      setHandoverOpen(false)
      router.refresh()
    })
  }

  function submitStatusChange() {
    startTransition(async () => {
      const result = await setUserDisabled(user.id, !disabled, reason)
      if (!result.ok) {
        toast.error(result.error ?? (disabled ? '恢复失败' : '停用失败'))
        return
      }
      toast.success(disabled ? '账号已恢复' : '账号已停用，历史数据保持不变')
      setStatusOpen(false)
      setReason('')
      router.refresh()
    })
  }

  return (
    <>
      {candidates.length > 0 && (
        <Button size="sm" variant="outline" disabled={pending} onClick={openHandover}>
          <ArrowRightLeft className="h-3.5 w-3.5" />
          离职交接
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={pending || (!disabled && !canDisable)}
        title={!disabled && !canDisable ? '至少需保留一名已通过审核的管理员' : undefined}
        className={disabled ? undefined : 'text-destructive'}
        onClick={() => {
          setReason('')
          setStatusOpen(true)
        }}
      >
        {disabled ? <UserCheck className="h-3.5 w-3.5" /> : <UserX className="h-3.5 w-3.5" />}
        {disabled ? '恢复' : '停用'}
      </Button>

      <Dialog open={handoverOpen} onOpenChange={setHandoverOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>办理「{displayName(user)}」离职交接</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>接手账号</Label>
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger>
                  <SelectValue placeholder="选择已通过审核的接手账号" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {displayName(candidate)}（{candidate.email}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={transferCustomers}
                disabled={pending}
                onChange={(event) => {
                  setTransferCustomers(event.target.checked)
                  if (!event.target.checked) setTransferOpenOrders(false)
                }}
              />
              <span>
                转移原账号的全部客户
                <span className="block text-xs text-muted-foreground">
                  历史 PI 创建人和历史姓名不变，接手人通过客户归属继续查看资料。
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={transferOpenOrders}
                disabled={pending || !transferCustomers}
                onChange={(event) => setTransferOpenOrders(event.target.checked)}
              />
              <span>
                同时转移这些客户的未完成订单
                <span className="block text-xs text-muted-foreground">
                  只转草稿、待审、驳回及未审核每日订单；已审核、已完成记录保持原归属。
                </span>
              </span>
            </label>

            {!disabled && (
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={disableSource}
                  disabled={pending || !canDisable}
                  onChange={(event) => setDisableSource(event.target.checked)}
                />
                <span>
                  交接完成后停用原账号
                  {!canDisable && (
                    <span className="block text-xs text-muted-foreground">
                      当前为最后一名已通过审核的管理员，不能停用。
                    </span>
                  )}
                </span>
              </label>
            )}

            <div className="space-y-2">
              <Label htmlFor={`handover-reason-${user.id}`}>交接原因</Label>
              <Textarea
                id={`handover-reason-${user.id}`}
                value={reason}
                maxLength={1000}
                placeholder="例如：员工离职，由张三接手"
                disabled={pending}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setHandoverOpen(false)}>
              取消
            </Button>
            <Button disabled={pending || !targetId || !reason.trim()} onClick={submitHandover}>
              {pending ? '处理中…' : '确认交接'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{disabled ? '恢复账号' : '停用账号'}「{displayName(user)}」</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {disabled
                ? '恢复后该账号可重新登录，历史数据不会变化。'
                : '停用后该账号不能继续访问系统，客户和历史记录不会被删除。若需转交业务，请优先使用“离职交接”。'}
            </p>
            {!disabled && (
              <div className="space-y-2">
                <Label htmlFor={`disable-reason-${user.id}`}>停用原因</Label>
                <Textarea
                  id={`disable-reason-${user.id}`}
                  value={reason}
                  maxLength={1000}
                  placeholder="请输入停用原因"
                  disabled={pending}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setStatusOpen(false)}>
              取消
            </Button>
            <Button
              variant={disabled ? 'default' : 'destructive'}
              disabled={pending || (!disabled && !reason.trim())}
              onClick={submitStatusChange}
            >
              {pending ? '处理中…' : disabled ? '确认恢复' : '确认停用'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
