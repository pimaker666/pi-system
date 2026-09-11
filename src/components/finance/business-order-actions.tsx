'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertCircle, Check, Pencil, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Textarea } from '@/components/ui/textarea'
import {
  approveBusinessOrder,
  closeBusinessOrderSpecial,
  completeBusinessOrder,
  rejectBusinessOrder,
  saveBusinessOrderFinance,
  submitBusinessOrder,
} from '@/lib/actions/business-orders'
import type { BusinessOrder, BusinessOrderFinanceDetail, Profile } from '@/types'

interface BusinessOrderActionsProps {
  order: Pick<
    BusinessOrder,
    | 'id'
    | 'status'
    | 'version'
    | 'salesperson_id'
    | 'approval_status'
    | 'payment_status'
    | 'fulfillment_status'
  > & { closed_at?: string | null }
  profile: Pick<Profile, 'id' | 'role'>
  financeReady: boolean
  canEditOrder?: boolean
}

export function BusinessOrderActions({
  order,
  profile,
  financeReady,
  canEditOrder,
}: BusinessOrderActionsProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectNote, setRejectNote] = useState('')
  const [closeOpen, setCloseOpen] = useState(false)
  const [closeReason, setCloseReason] = useState('')

  const isClosed = Boolean(order.closed_at)
  const canOwnerEdit =
    (profile.role === 'admin' ||
      ((profile.role === 'sales' || profile.role === 'supervisor') &&
        order.salesperson_id === profile.id)) &&
    ['draft', 'rejected'].includes(order.status) &&
    !isClosed
  const completionMissing = [
    order.approval_status !== 'approved' ? '审核尚未通过' : null,
    order.payment_status !== 'fully_paid' ? '款项尚未收齐' : null,
    order.fulfillment_status !== 'fully_shipped' ? '商品尚未全部发货' : null,
    !financeReady ? '财务核算尚未完整保存' : null,
  ].filter((item): item is string => Boolean(item))
  const canComplete =
    !isClosed &&
    profile.role === 'finance' &&
    order.status === 'approved' &&
    completionMissing.length === 0
  const canSpecialClose =
    !isClosed && profile.role === 'admin' && order.status !== 'completed'
  const showEditOrder = canEditOrder ?? canOwnerEdit

  function runAction(
    action: () => Promise<{ ok: boolean; error?: string }>,
    success: string,
    onSuccess?: () => void,
  ) {
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        toast.error(result.error ?? '操作失败')
        return
      }
      toast.success(success)
      setRejectOpen(false)
      setRejectNote('')
      onSuccess?.()
      router.refresh()
    })
  }

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {!isClosed && (
        <>
          {showEditOrder && (
            <Button asChild variant="outline">
              <Link href={`/finance/daily-orders/${order.id}/edit`}>
                <Pencil className="h-4 w-4" />编辑订单
              </Link>
            </Button>
          )}
          {canOwnerEdit && (
            <Button
              disabled={pending}
              onClick={() => runAction(() => submitBusinessOrder(order.id), '订单已提交审核')}
            >
              <Send className="h-4 w-4" />提交审核
            </Button>
          )}
          {profile.role === 'admin' && order.status === 'submitted' && (
            <>
              <Button
                disabled={pending}
                onClick={() => runAction(() => approveBusinessOrder(order.id), '订单已审核通过')}
              >
                <Check className="h-4 w-4" />审核通过
              </Button>
              <Button variant="destructive" disabled={pending} onClick={() => setRejectOpen(true)}>
                <X className="h-4 w-4" />驳回
              </Button>
            </>
          )}
          {profile.role === 'finance' && order.status === 'approved' && (
            <div className="flex w-full flex-col items-end gap-1 sm:w-auto">
              <Button
                disabled={pending || !canComplete}
                onClick={() => runAction(() => completeBusinessOrder(order.id), '订单已完成并锁定')}
              >
                <Check className="h-4 w-4" />完成订单
              </Button>
              {completionMissing.length > 0 && (
                <div className="flex max-w-full items-start gap-1 text-right text-xs text-muted-foreground">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>暂不可完成：{completionMissing.join('、')}</span>
                </div>
              )}
            </div>
          )}
          {canSpecialClose && (
            <Button variant="destructive" disabled={pending} onClick={() => setCloseOpen(true)}>
              <X className="h-4 w-4" />特殊关闭
            </Button>
          )}
        </>
      )}

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>驳回业务订单</DialogTitle>
            <DialogDescription>请说明需要业务员修改的内容。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject_note">驳回原因</Label>
            <Textarea
              id="reject_note"
              value={rejectNote}
              onChange={(event) => setRejectNote(event.target.value)}
              maxLength={1000}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>取消</Button>
            <Button
              variant="destructive"
              disabled={pending || !rejectNote.trim()}
              onClick={() => runAction(() => rejectBusinessOrder(order.id, rejectNote), '订单已驳回')}
            >
              确认驳回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={closeOpen}
        onOpenChange={(open) => {
          setCloseOpen(open)
          if (!open) setCloseReason('')
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>特殊关闭业务订单</DialogTitle>
            <DialogDescription>
              特殊关闭不会伪造收齐款项、全部发货或正常完成状态；订单事实与审计记录会继续保留。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="special_close_reason">关闭原因</Label>
            <Textarea
              id="special_close_reason"
              value={closeReason}
              onChange={(event) => setCloseReason(event.target.value)}
              maxLength={1000}
              required
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloseOpen(false)}>取消</Button>
            <Button
              variant="destructive"
              disabled={pending || !closeReason.trim()}
              onClick={() =>
                runAction(
                  () => closeBusinessOrderSpecial(order.id, order.version, closeReason),
                  '订单已特殊关闭',
                  () => {
                    setCloseOpen(false)
                    setCloseReason('')
                  },
                )
              }
            >
              {pending ? '关闭中…' : '确认特殊关闭'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface BusinessOrderFinancePanelProps {
  order: Pick<BusinessOrder, 'id' | 'status'> & { closed_at?: string | null }
  financeDetail: BusinessOrderFinanceDetail | null
  role: Profile['role']
}

export function BusinessOrderFinancePanel({
  order,
  financeDetail,
  role,
}: BusinessOrderFinancePanelProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [wage, setWage] = useState(String(financeDetail?.wage_amount_cny ?? ''))
  const [notes, setNotes] = useState(financeDetail?.calculation_notes ?? '')
  const canEdit =
    !order.closed_at && role === 'finance' && order.status === 'approved'

  if (!canEdit && !financeDetail) return null

  function handleSave() {
    startTransition(async () => {
      const result = await saveBusinessOrderFinance(order.id, {
        wage_amount_cny: wage,
        calculation_notes: notes,
        reason: '',
      })
      if (!result.ok) {
        toast.error(result.error ?? '保存财务核算失败')
        return
      }
      toast.success('财务核算已保存')
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">工资 / 提成核算</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="wage_amount">工资 / 提成金额（CNY）</Label>
          <Input
            id="wage_amount"
            type="number"
            min="0"
            step="0.01"
            value={wage}
            onChange={(event) => setWage(event.target.value)}
            readOnly={!canEdit}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="calculation_notes">计算说明</Label>
          <Textarea
            id="calculation_notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={4000}
            readOnly={!canEdit}
          />
        </div>
        {canEdit && (
          <Button
            onClick={handleSave}
            disabled={pending || !notes.trim()}
          >
            {pending ? '保存中…' : '保存核算'}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
