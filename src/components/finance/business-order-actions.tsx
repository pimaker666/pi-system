'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Check, Pencil, Send, X } from 'lucide-react'
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
  completeBusinessOrder,
  rejectBusinessOrder,
  saveBusinessOrderFinance,
  submitBusinessOrder,
} from '@/lib/actions/business-orders'
import type { BusinessOrder, BusinessOrderFinanceDetail, Profile } from '@/types'

interface BusinessOrderActionsProps {
  order: Pick<BusinessOrder, 'id' | 'status' | 'salesperson_id'>
  profile: Pick<Profile, 'id' | 'role'>
}

export function BusinessOrderActions({ order, profile }: BusinessOrderActionsProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectNote, setRejectNote] = useState('')

  const canSalesEdit =
    (profile.role === 'sales' || profile.role === 'supervisor') &&
    order.salesperson_id === profile.id &&
    ['draft', 'rejected'].includes(order.status)
  const canCorrect =
    (profile.role === 'admin' || profile.role === 'finance') && order.status === 'completed'

  function runAction(action: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        toast.error(result.error ?? '操作失败')
        return
      }
      toast.success(success)
      setRejectOpen(false)
      setRejectNote('')
      router.refresh()
    })
  }

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {(canSalesEdit || canCorrect) && (
        <Button asChild variant="outline">
          <Link href={`/finance/performance/${order.id}/edit`}>
            <Pencil className="h-4 w-4" />
            {canCorrect ? '修正订单' : '编辑订单'}
          </Link>
        </Button>
      )}
      {canSalesEdit && (
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
        <Button
          disabled={pending}
          onClick={() => runAction(() => completeBusinessOrder(order.id), '订单已完成并锁定')}
        >
          <Check className="h-4 w-4" />完成订单
        </Button>
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
    </div>
  )
}

interface BusinessOrderFinancePanelProps {
  order: Pick<BusinessOrder, 'id' | 'status'>
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
  const [reason, setReason] = useState('')
  const canEdit =
    (role === 'finance' && order.status === 'approved') ||
    ((role === 'admin' || role === 'finance') && order.status === 'completed')
  const reasonRequired = order.status === 'completed'

  if (!canEdit && !financeDetail) return null

  function handleSave() {
    startTransition(async () => {
      const result = await saveBusinessOrderFinance(order.id, {
        wage_amount_cny: wage,
        calculation_notes: notes,
        reason,
      })
      if (!result.ok) {
        toast.error(result.error ?? '保存财务核算失败')
        return
      }
      toast.success('财务核算已保存')
      setReason('')
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
        {canEdit && reasonRequired && (
          <div className="space-y-2">
            <Label htmlFor="finance_reason">修正原因</Label>
            <Textarea
              id="finance_reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={1000}
            />
          </div>
        )}
        {canEdit && (
          <Button
            onClick={handleSave}
            disabled={pending || !notes.trim() || (reasonRequired && !reason.trim())}
          >
            {pending ? '保存中…' : '保存核算'}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
