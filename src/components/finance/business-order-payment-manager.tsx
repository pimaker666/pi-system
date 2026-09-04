'use client'

import { FormEvent, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  addBusinessOrderPayment,
  getBusinessOrderPaymentProofUrl,
  updateBusinessOrderPayment,
  voidBusinessOrderPayment,
} from '@/lib/actions/business-orders'
import { BUSINESS_PAYMENT_LABELS } from '@/lib/business-orders'
import { formatCny } from '@/lib/finance'
import { createClient } from '@/lib/supabase/client'
import { formatCurrency, formatDate } from '@/lib/utils'
import type {
  BusinessOrderPayment,
  BusinessOrderStatus,
  BusinessPaymentType,
  CurrencyCode,
  Profile,
} from '@/types'

interface BusinessOrderPaymentManagerProps {
  orderId: string
  ownerId: string | null
  currency: CurrencyCode
  status: BusinessOrderStatus
  profile: Pick<Profile, 'id' | 'role'>
  payments: BusinessOrderPayment[]
}

function toDateTimeLocal(value?: string) {
  const date = value ? new Date(value) : new Date()
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

export function BusinessOrderPaymentManager({
  orderId,
  ownerId,
  currency,
  status,
  profile,
  payments,
}: BusinessOrderPaymentManagerProps) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [pending, startTransition] = useTransition()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<BusinessOrderPayment | null>(null)
  const [paymentType, setPaymentType] = useState<BusinessPaymentType>('full')
  const [amount, setAmount] = useState('')
  const [receivedAt, setReceivedAt] = useState(toDateTimeLocal())
  const [notes, setNotes] = useState('')
  const [reason, setReason] = useState('')
  const [voiding, setVoiding] = useState<BusinessOrderPayment | null>(null)
  const [voidReason, setVoidReason] = useState('')

  const salesCanEdit =
    (profile.role === 'sales' || profile.role === 'supervisor') &&
    ownerId === profile.id &&
    ['draft', 'rejected'].includes(status)
  const privilegedCanCorrect =
    (profile.role === 'admin' || profile.role === 'finance') && status === 'completed'
  const canEditPayments = salesCanEdit || privilegedCanCorrect

  function openForm(payment?: BusinessOrderPayment) {
    const current = payment ?? null
    setEditing(current)
    setPaymentType(current?.payment_type ?? 'full')
    setAmount(current ? String(current.amount) : '')
    setReceivedAt(toDateTimeLocal(current?.received_at))
    setNotes(current?.notes ?? '')
    setReason('')
    setFormOpen(true)
  }

  async function uploadProof(file: File) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      throw new Error('凭证仅支持 JPG、PNG 或 WebP 图片')
    }
    if (file.size > 10 * 1024 * 1024) throw new Error('凭证图片不能超过 10MB')
    const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
    const path = `${profile.id}/${orderId}/${crypto.randomUUID()}.${extension}`
    const supabase = createClient()
    const { error } = await supabase.storage
      .from('business-payment-proofs')
      .upload(path, file, { contentType: file.type, upsert: false })
    if (error) throw new Error(error.message)
    return path
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const file = fileRef.current?.files?.[0]
    if (!editing && !file) {
      toast.error('请上传收款截图凭证')
      return
    }
    if (privilegedCanCorrect && !reason.trim()) {
      toast.error('修正已完成订单时必须填写原因')
      return
    }

    startTransition(async () => {
      try {
        const proofPath = file ? await uploadProof(file) : editing?.proof_path
        if (!proofPath) throw new Error('请上传收款截图凭证')
        const input = {
          payment_type: paymentType,
          amount,
          received_at: receivedAt,
          proof_path: proofPath,
          notes,
          reason,
        }
        const result = editing
          ? await updateBusinessOrderPayment(editing.id, input)
          : await addBusinessOrderPayment(orderId, input)
        if (!result.ok) throw new Error(result.error ?? '保存收款失败')

        toast.success(editing ? '收款记录已更新' : '收款记录已添加')
        setFormOpen(false)
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '保存收款失败')
      }
    })
  }

  function handleView(paymentId: string) {
    startTransition(async () => {
      const result = await getBusinessOrderPaymentProofUrl(paymentId)
      if (!result.url) {
        toast.error(result.error ?? '凭证打开失败')
        return
      }
      window.open(result.url, '_blank', 'noopener,noreferrer')
    })
  }

  function handleVoid() {
    if (!voiding) return
    if (privilegedCanCorrect && !voidReason.trim()) {
      toast.error('修正已完成订单时必须填写原因')
      return
    }
    startTransition(async () => {
      const result = await voidBusinessOrderPayment(voiding.id, voidReason)
      if (!result.ok) {
        toast.error(result.error ?? '作废收款失败')
        return
      }
      toast.success('收款记录已作废')
      setVoiding(null)
      setVoidReason('')
      router.refresh()
    })
  }

  const activePayments = payments.filter((payment) => !payment.voided_at)
  const activeTotalCny = activePayments.reduce(
    (sum, payment) => sum + Number(payment.amount) * Number(payment.exchange_rate_to_cny),
    0,
  )
  const canVoidActivePayment = status !== 'completed' || activePayments.length > 1

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">收款记录</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            有效收款折合人民币合计：{formatCny(activeTotalCny)}
          </p>
        </div>
        {canEditPayments && (
          <Button size="sm" onClick={() => openForm()}>
            <Plus className="h-4 w-4" />新增收款
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {payments.map((payment) => (
          <div key={payment.id} className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">{BUSINESS_PAYMENT_LABELS[payment.payment_type]}</span>
                {payment.voided_at && <Badge variant="secondary">已作废</Badge>}
              </div>
              <div className="text-sm text-muted-foreground">
                {formatDate(payment.received_at, true)} · {payment.notes || '无备注'}
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 sm:justify-end">
              <span className="text-right font-semibold tabular-nums">
                <span className="block">
                  {formatCurrency(Number(payment.amount), payment.currency)}
                </span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {formatCny(Number(payment.amount) * Number(payment.exchange_rate_to_cny))}
                </span>
              </span>
              <Button variant="ghost" size="icon" disabled={pending} onClick={() => handleView(payment.id)} aria-label="查看凭证">
                <Eye className="h-4 w-4" />
              </Button>
              {canEditPayments && !payment.voided_at && (
                <>
                  <Button variant="ghost" size="icon" onClick={() => openForm(payment)} aria-label="修改收款">
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={pending || !canVoidActivePayment}
                    onClick={() => setVoiding(payment)}
                    aria-label="作废收款"
                    title={!canVoidActivePayment ? '已完成订单必须保留至少一笔有效收款' : undefined}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
        {payments.length === 0 && (
          <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
            暂无收款记录
          </div>
        )}
      </CardContent>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? '修改收款' : '新增收款'}</DialogTitle>
            <DialogDescription>每笔收款都必须保留独立截图凭证。</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>收款类型</Label>
                <Select value={paymentType} onValueChange={(value) => setPaymentType(value as BusinessPaymentType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full">全款</SelectItem>
                    <SelectItem value="deposit">定金</SelectItem>
                    <SelectItem value="balance">尾款</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="payment_amount">金额（{editing?.currency ?? currency}）</Label>
                <Input id="payment_amount" type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="received_at">收款时间</Label>
                <Input id="received_at" type="datetime-local" value={receivedAt} onChange={(event) => setReceivedAt(event.target.value)} required />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="proof">收款截图{editing ? '（不选择则保留原凭证）' : ''}</Label>
                <Input ref={fileRef} id="proof" type="file" accept="image/jpeg,image/png,image/webp" required={!editing} />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="payment_notes">备注</Label>
                <Textarea id="payment_notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} />
              </div>
              {privilegedCanCorrect && (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="payment_reason">修正原因</Label>
                  <Textarea id="payment_reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} required />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>取消</Button>
              <Button type="submit" disabled={pending}>{pending ? '保存中…' : '保存收款'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(voiding)} onOpenChange={(open) => !open && setVoiding(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>作废收款记录</DialogTitle>
            <DialogDescription>记录将保留并标记为已作废，凭证不会删除。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="void_reason">说明{privilegedCanCorrect ? '（必填）' : '（可选）'}</Label>
            <Textarea id="void_reason" value={voidReason} onChange={(event) => setVoidReason(event.target.value)} maxLength={1000} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVoiding(null)}>取消</Button>
            <Button variant="destructive" disabled={pending || (privilegedCanCorrect && !voidReason.trim())} onClick={handleVoid}>确认作废</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
