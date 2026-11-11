'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowUpRight, Check, RotateCcw, X } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { cancelApproval, decideApproval, retryApproval } from '@/lib/actions/approvals'
import { cn, formatDate } from '@/lib/utils'
import type {
  ApprovalInboxItem,
  ApprovalInboxScope,
  ApprovalRequestStatus,
  ApprovalSideTodo,
} from '@/types'

const SCOPES: { value: ApprovalInboxScope; label: string }[] = [
  { value: 'pending', label: '待我审批' },
  { value: 'mine', label: '我发起的' },
  { value: 'done', label: '已处理' },
]

const STATUS_LABELS: Record<ApprovalRequestStatus, string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
  cancelled: '已撤回',
  applied: '已执行',
  apply_failed: '执行失败',
}

const STATUS_VARIANTS: Record<
  ApprovalRequestStatus,
  'secondary' | 'success' | 'destructive' | 'muted' | 'outline'
> = {
  pending: 'secondary',
  approved: 'success',
  rejected: 'destructive',
  cancelled: 'muted',
  applied: 'success',
  apply_failed: 'destructive',
}

function orderHref(item: ApprovalInboxItem) {
  if (item.entity_type !== 'business_order') return null
  return `/finance/daily-orders/${item.entity_id}`
}

export function ApprovalCenter({
  scope,
  items,
  pendingCount,
  sideTodos = [],
}: {
  scope: ApprovalInboxScope
  items: ApprovalInboxItem[]
  pendingCount: number
  sideTodos?: ApprovalSideTodo[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [decision, setDecision] = useState<{
    item: ApprovalInboxItem
    value: 'approve' | 'reject'
  } | null>(null)
  const [note, setNote] = useState('')

  function openDecision(item: ApprovalInboxItem, value: 'approve' | 'reject') {
    setDecision({ item, value })
    setNote('')
  }

  function submitDecision() {
    if (!decision) return
    if (decision.value === 'reject' && !note.trim()) {
      toast.error('驳回时必须填写原因')
      return
    }
    startTransition(async () => {
      const result = await decideApproval({
        request_id: decision.item.id,
        decision: decision.value,
        note: note.trim() || undefined,
      })
      if (!result.ok) {
        toast.error(result.error ?? '审批失败')
        if (result.status === 'apply_failed') {
          setDecision(null)
          router.refresh()
        }
        return
      }
      toast.success(
        decision.value === 'reject'
          ? '已驳回'
          : result.status === 'pending'
            ? '已通过，等待下一级审核'
            : '已通过，业务动作已自动执行',
      )
      setDecision(null)
      router.refresh()
    })
  }

  function run(
    action: () => Promise<{ ok: boolean; error?: string; status?: string }>,
    successText: string,
  ) {
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        toast.error(result.error ?? '操作失败')
        if (result.status === 'apply_failed') router.refresh()
        return
      }
      toast.success(successText)
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 border-b pb-4">
        {SCOPES.map((entry) => {
          const active = entry.value === scope
          return (
            <Link
              key={entry.value}
              href={`/approvals?scope=${entry.value}`}
              className={cn(
                'inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {entry.label}
              {entry.value === 'pending' && pendingCount > 0 && (
                <span className="rounded-full bg-red-600 px-1.5 text-[11px] font-semibold leading-5 text-white">
                  {pendingCount > 99 ? '99+' : pendingCount}
                </span>
              )}
            </Link>
          )
        })}
      </div>

      {scope === 'pending' && sideTodos.length > 0 && (
        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="mb-2 text-sm font-medium">其他待办</p>
          <div className="space-y-1">
            {sideTodos.map((todo) => (
              <Link
                key={todo.id}
                href={todo.href}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-background"
              >
                <span className="font-medium">{todo.label}：{todo.title}</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {todo.detail}
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {scope === 'pending'
            ? '当前没有待你审批的申请'
            : scope === 'mine'
              ? '你还没有发起过审批'
              : '还没有处理过的审批记录'}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const href = orderHref(item)
            return (
              <div key={item.id} className="rounded-lg border bg-card p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{item.summary}</span>
                      <Badge variant="outline">{item.action_name}</Badge>
                      {item.order_number && (
                        <span className="text-xs text-muted-foreground">{item.order_number}</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      发起人 {item.requester_name} · {formatDate(item.requested_at, true)}
                      {item.decided_at ? ` · 处理于 ${formatDate(item.decided_at, true)}` : ''}
                    </p>
                    {item.note && <p className="text-xs text-muted-foreground">说明：{item.note}</p>}
                    {item.apply_error && (
                      <p className="text-xs text-destructive">自动执行失败：{item.apply_error}</p>
                    )}
                  </div>
                  <Badge variant={STATUS_VARIANTS[item.status] ?? 'outline'}>
                    {STATUS_LABELS[item.status] ?? item.status}
                  </Badge>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                  {href && (
                    <Button asChild variant="ghost" size="sm">
                      <Link href={href} target="_blank" rel="noopener noreferrer">
                        查看订单
                        <ArrowUpRight className="h-4 w-4" />
                      </Link>
                    </Button>
                  )}
                  {item.status === 'pending' && !item.can_decide && scope === 'mine' && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => run(() => cancelApproval(item.id), '已撤回审批申请')}
                    >
                      <RotateCcw className="h-4 w-4" />
                      撤回
                    </Button>
                  )}
                  {item.status === 'pending' && item.can_decide && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => openDecision(item, 'reject')}
                      >
                        <X className="h-4 w-4" />
                        驳回
                      </Button>
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => openDecision(item, 'approve')}
                      >
                        <Check className="h-4 w-4" />
                        通过
                      </Button>
                    </>
                  )}
                  {item.status === 'apply_failed' && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => run(() => retryApproval(item.id), '已重新执行')}
                    >
                      <RotateCcw className="h-4 w-4" />
                      重试执行
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Dialog open={decision !== null} onOpenChange={(open) => !open && setDecision(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{decision?.value === 'approve' ? '通过审批' : '驳回审批'}</DialogTitle>
            <DialogDescription>
              {decision?.value === 'approve'
                ? '通过后系统会立即自动执行业务动作；如执行失败可在列表中重试。'
                : '驳回后申请不会执行，发起人可修改后重新提交。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm font-medium">
              {decision?.item.summary}
            </p>
            <Textarea
              value={note}
              disabled={pending}
              placeholder={decision?.value === 'approve' ? '审批说明（可选）' : '请填写驳回原因'}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setDecision(null)}>
              取消
            </Button>
            <Button disabled={pending} onClick={submitDecision}>
              {pending ? '处理中…' : decision?.value === 'approve' ? '确认通过' : '确认驳回'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
