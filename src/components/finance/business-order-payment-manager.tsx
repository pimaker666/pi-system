'use client'

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, Plus, RefreshCw, Trash2, WalletCards } from 'lucide-react'
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
  allocateBusinessCustomerTransfer,
  getBusinessCustomerPrepayment,
  getBusinessOrderSettlementSummary,
  recordBusinessCustomerTransfer,
  voidBusinessCustomerTransfer,
  voidBusinessOrderPaymentAllocation,
} from '@/lib/actions/business-orders'
import {
  BUSINESS_PAYMENT_LABELS,
  businessDateTimeLocalToIso,
  getBusinessDateTimeLocal,
  getBusinessOverdueDays,
} from '@/lib/business-orders'
import { createClient } from '@/lib/supabase/client'
import { formatCurrency, formatDate } from '@/lib/utils'
import type {
  BusinessCustomerTransfer,
  BusinessOrderPaymentAllocation,
  BusinessOrderSettlementSummary,
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
  completionGateVersion: number
  profile: Pick<Profile, 'id' | 'role'>
  /** 详情页仍会传入旧只读数据；新组件不会读取或写入旧付款表。 */
  payments?: unknown[]
}

interface OrderOption {
  id: string
  order_number: string
  salesperson_id: string | null
  total_amount: number
  payment_due_date: string | null
  payment_status: 'unpaid' | 'partially_paid' | 'fully_paid'
  status: BusinessOrderStatus
  completion_gate_version: number
}

type AllocationRow = BusinessOrderPaymentAllocation

type AllocationDraft = Record<string, string>

interface PendingTransferUpload {
  customer_id: string
  currency: CurrencyCode
  idempotency_key: string
  proof_path: string | null
}

function newUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16)
    const value = token === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

function amountValue(value: string) {
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0
}

function paymentTypeLabel(type: BusinessPaymentType) {
  return BUSINESS_PAYMENT_LABELS[type]
}

export function BusinessOrderPaymentManager({
  orderId,
  ownerId,
  currency,
  status,
  completionGateVersion,
  profile,
}: BusinessOrderPaymentManagerProps) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [pending, startTransition] = useTransition()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [orders, setOrders] = useState<OrderOption[]>([])
  const [transfers, setTransfers] = useState<BusinessCustomerTransfer[]>([])
  const [allocations, setAllocations] = useState<AllocationRow[]>([])
  const [settlement, setSettlement] = useState<BusinessOrderSettlementSummary | null>(null)
  const [prepayment, setPrepayment] = useState(0)

  const [formOpen, setFormOpen] = useState(false)
  const [paymentType, setPaymentType] = useState<BusinessPaymentType>('full')
  const [amount, setAmount] = useState('')
  const [exchangeRate, setExchangeRate] = useState(currency === 'CNY' ? '1' : '')
  const [receivedAt, setReceivedAt] = useState(getBusinessDateTimeLocal())
  const [notes, setNotes] = useState('')
  const [allocationDraft, setAllocationDraft] = useState<AllocationDraft>({})
  const [correctionReason, setCorrectionReason] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const [uploadedProofPath, setUploadedProofPath] = useState<string | null>(null)

  const [allocatingTransfer, setAllocatingTransfer] = useState<BusinessCustomerTransfer | null>(null)
  const [extraAllocationDraft, setExtraAllocationDraft] = useState<AllocationDraft>({})
  const [allocationCorrectionReason, setAllocationCorrectionReason] = useState('')
  const [allocationIdempotencyKey, setAllocationIdempotencyKey] = useState('')

  const [voidTarget, setVoidTarget] = useState<
    | { kind: 'transfer'; item: BusinessCustomerTransfer }
    | { kind: 'allocation'; item: AllocationRow }
    | null
  >(null)
  const [voidReason, setVoidReason] = useState('')

  const hasRolePermission =
    profile.role === 'admin' ||
    profile.role === 'finance' ||
    ((profile.role === 'sales' || profile.role === 'supervisor') && ownerId === profile.id)
  const canCorrectLegacyCompleted =
    status === 'completed' &&
    completionGateVersion < 2 &&
    (profile.role === 'admin' || profile.role === 'finance')
  const canManage =
    hasRolePermission && (status !== 'completed' || canCorrectLegacyCompleted)

  const loadData = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const supabase = createClient()
      const { data: currentOrder, error: orderError } = await supabase
        .from('business_orders')
        .select('id, customer_id, currency, exchange_rate_to_cny')
        .eq('id', orderId)
        .single()
      if (orderError || !currentOrder?.customer_id) {
        throw new Error(orderError?.message ?? '订单未关联客户，无法登记客户转账')
      }

      const currentCustomerId = currentOrder.customer_id as string
      const currentCurrency = currentOrder.currency as CurrencyCode
      const [ordersResult, transfersResult, allocationsResult, settlementResult, prepaymentResult] = await Promise.all([
        supabase
          .from('business_orders')
          .select(
            'id, order_number, salesperson_id, total_amount, payment_due_date, payment_status, status, completion_gate_version',
          )
          .eq('customer_id', currentCustomerId)
          .eq('currency', currentCurrency)
          .order('order_date', { ascending: false }),
        supabase
          .from('business_customer_transfers')
          .select('*')
          .eq('customer_id', currentCustomerId)
          .eq('currency', currentCurrency)
          .order('received_at', { ascending: false }),
        supabase
          .from('business_order_payment_allocations')
          .select(
            '*, order:business_orders!business_order_payment_allocations_order_id_fkey!inner(customer_id, currency)',
          )
          .eq('order.customer_id', currentCustomerId)
          .eq('order.currency', currentCurrency)
          .order('created_at', { ascending: false }),
        getBusinessOrderSettlementSummary(orderId),
        getBusinessCustomerPrepayment(currentCustomerId),
      ])
      if (ordersResult.error) throw new Error(ordersResult.error.message)
      if (transfersResult.error) throw new Error(transfersResult.error.message)
      if (allocationsResult.error) throw new Error(allocationsResult.error.message)
      if (!settlementResult.ok || !settlementResult.data) {
        throw new Error(settlementResult.error ?? '订单结算汇总读取失败')
      }
      if (!prepaymentResult.ok) {
        throw new Error(prepaymentResult.error ?? '客户预收余额读取失败')
      }

      const orderRows = (ordersResult.data ?? []) as OrderOption[]
      const transferRows = (transfersResult.data ?? []) as BusinessCustomerTransfer[]
      const allocationRows = (allocationsResult.data ?? []) as unknown as AllocationRow[]

      setCustomerId(currentCustomerId)
      setOrders(orderRows)
      setTransfers(transferRows)
      setAllocations(allocationRows)
      setSettlement(settlementResult.data)
      setExchangeRate(currentCurrency === 'CNY' ? '1' : String(currentOrder.exchange_rate_to_cny ?? ''))
      setPrepayment(
        Number(
          (prepaymentResult.data ?? []).find((item) => item.currency === currentCurrency)
            ?.available_balance ?? 0,
        ),
      )
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '收款数据读取失败')
    } finally {
      setLoading(false)
    }
  }, [orderId])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const transferById = useMemo(
    () => new Map(transfers.map((transfer) => [transfer.id, transfer])),
    [transfers],
  )

  const orderById = useMemo(() => new Map(orders.map((order) => [order.id, order])), [orders])

  const activePaidByOrder = useMemo(() => {
    const paid = new Map<string, number>()
    for (const allocation of allocations) {
      const transfer = transferById.get(allocation.transfer_id)
      if (allocation.voided_at || !transfer || transfer.voided_at) continue
      paid.set(allocation.order_id, (paid.get(allocation.order_id) ?? 0) + Number(allocation.amount))
    }
    return paid
  }, [allocations, transferById])

  const availableOrders = useMemo(
    () =>
      orders
        .filter((order) => {
          if (
            (profile.role === 'sales' || profile.role === 'supervisor') &&
            order.salesperson_id !== profile.id
          ) {
            return false
          }
          if (
            order.status === 'completed' &&
            (order.completion_gate_version >= 2 ||
              (profile.role !== 'admin' && profile.role !== 'finance'))
          ) {
            return false
          }
          return Number(order.total_amount) - (activePaidByOrder.get(order.id) ?? 0) > 0.005
        })
        .sort((a, b) => Number(b.id === orderId) - Number(a.id === orderId)),
    [activePaidByOrder, orderId, orders, profile.id, profile.role],
  )

  const currentAllocations = useMemo(
    () => allocations.filter((allocation) => allocation.order_id === orderId),
    [allocations, orderId],
  )

  function transferAllocated(transferId: string) {
    return allocations
      .filter((allocation) => allocation.transfer_id === transferId && !allocation.voided_at)
      .reduce((sum, allocation) => sum + Number(allocation.amount), 0)
  }

  function transferAvailable(transfer: BusinessCustomerTransfer) {
    if (transfer.voided_at) return 0
    return Math.max(Number(transfer.amount) - transferAllocated(transfer.id), 0)
  }

  const pendingUploadStorageKey = `business-transfer-upload:${profile.id}:${orderId}`

  function readPendingUpload() {
    try {
      const raw = sessionStorage.getItem(pendingUploadStorageKey)
      if (!raw) return null
      const draft = JSON.parse(raw) as PendingTransferUpload
      if (
        draft.customer_id !== customerId ||
        draft.currency !== currency ||
        !draft.idempotency_key
      ) {
        sessionStorage.removeItem(pendingUploadStorageKey)
        return null
      }
      return draft
    } catch {
      sessionStorage.removeItem(pendingUploadStorageKey)
      return null
    }
  }

  function writePendingUpload(next: PendingTransferUpload) {
    sessionStorage.setItem(pendingUploadStorageKey, JSON.stringify(next))
  }

  function clearPendingUpload() {
    sessionStorage.removeItem(pendingUploadStorageKey)
  }

  function openForm() {
    const pendingUpload = readPendingUpload()
    const nextIdempotencyKey = pendingUpload?.idempotency_key ?? newUuid()
    setPaymentType('full')
    setAmount('')
    setReceivedAt(getBusinessDateTimeLocal())
    setNotes('')
    setAllocationDraft({})
    setCorrectionReason('')
    setIdempotencyKey(nextIdempotencyKey)
    setUploadedProofPath(pendingUpload?.proof_path ?? null)
    if (!pendingUpload && customerId) {
      writePendingUpload({
        customer_id: customerId,
        currency,
        idempotency_key: nextIdempotencyKey,
        proof_path: null,
      })
    }
    if (fileRef.current) fileRef.current.value = ''
    setFormOpen(true)
  }

  function closeForm() {
    clearPendingUpload()
    setIdempotencyKey('')
    setUploadedProofPath(null)
    setFormOpen(false)
  }

  async function uploadProof(file: File, targetCustomerId: string, objectId: string) {
    const extension = file.name.split('.').pop()?.toLowerCase()
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'webp']
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp']
    if (!extension || !allowedExtensions.includes(extension) || !allowedTypes.includes(file.type)) {
      throw new Error('凭证仅支持 JPG、JPEG、PNG 或 WebP 图片')
    }
    if (file.size > 5 * 1024 * 1024) throw new Error('凭证图片不能超过 5MB')

    const fileName = `${objectId}.${extension}`
    const folder = `${profile.id}/customer/${targetCustomerId}`
    const path = `${folder}/${fileName}`
    const supabase = createClient()
    const bucket = supabase.storage.from('business-payment-proofs')
    const { error } = await bucket.upload(path, file, { contentType: file.type, upsert: false })
    if (error) {
      const { data: existing, error: listError } = await bucket.list(folder, {
        limit: 100,
        search: fileName,
      })
      if (listError || !existing?.some((item) => item.name === fileName)) {
        throw new Error(error.message)
      }
    }
    return path
  }

  function buildAllocations(draft: AllocationDraft) {
    return Object.entries(draft)
      .map(([targetOrderId, value]) => ({ order_id: targetOrderId, amount: amountValue(value) }))
      .filter((allocation) => allocation.amount > 0)
  }

  function allocationsNeedCorrection(draft: AllocationDraft) {
    return buildAllocations(draft).some(({ order_id: targetOrderId }) => {
      const targetOrder = orderById.get(targetOrderId)
      return targetOrder?.status === 'completed' && targetOrder.completion_gate_version < 2
    })
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const file = fileRef.current?.files?.[0]
    if (!customerId || (!file && !uploadedProofPath)) {
      toast.error(!customerId ? '订单未关联客户' : '请上传收款截图凭证')
      return
    }

    const transferAmount = amountValue(amount)
    const rate = Number(exchangeRate)
    const nextAllocations = buildAllocations(allocationDraft)
    const allocatedAmount = nextAllocations.reduce((sum, allocation) => sum + allocation.amount, 0)
    if (transferAmount <= 0) {
      toast.error('转账金额必须大于 0')
      return
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      toast.error('请输入有效汇率')
      return
    }
    if (allocatedAmount > transferAmount + 0.005) {
      toast.error('分摊合计不能超过转账金额')
      return
    }
    const needsCorrection = allocationsNeedCorrection(allocationDraft)
    if (needsCorrection && !correctionReason.trim()) {
      toast.error('分摊到历史已完成订单时必须填写修正原因')
      return
    }
    if (!idempotencyKey) {
      toast.error('转账请求标识已失效，请关闭后重新打开表单')
      return
    }

    let receivedAtIso: string
    try {
      receivedAtIso = businessDateTimeLocalToIso(receivedAt)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '请选择有效收款时间')
      return
    }

    startTransition(async () => {
      try {
        let proofPath = uploadedProofPath
        if (!proofPath) {
          if (!file) throw new Error('请上传收款截图凭证')
          proofPath = await uploadProof(file, customerId, idempotencyKey)
          setUploadedProofPath(proofPath)
          writePendingUpload({
            customer_id: customerId,
            currency,
            idempotency_key: idempotencyKey,
            proof_path: proofPath,
          })
        }
        const result = await recordBusinessCustomerTransfer({
          customer_id: customerId,
          currency,
          amount: transferAmount,
          exchange_rate_to_cny: rate,
          received_at: receivedAtIso,
          payment_type: paymentType,
          proof_path: proofPath,
          notes,
          correction_reason: needsCorrection ? correctionReason : '',
          idempotency_key: idempotencyKey,
          allocations: nextAllocations,
        })
        if (!result.ok) throw new Error(result.error ?? '登记客户转账失败')

        toast.success(
          allocatedAmount < transferAmount
            ? '客户转账已登记，未分摊余额已计入预收款'
            : '客户转账及分摊已登记',
        )
        clearPendingUpload()
        setFormOpen(false)
        setIdempotencyKey('')
        setUploadedProofPath(null)
        await loadData()
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '登记客户转账失败')
      }
    })
  }

  function openAllocation(transfer: BusinessCustomerTransfer) {
    setAllocatingTransfer(transfer)
    setExtraAllocationDraft({})
    setAllocationCorrectionReason('')
    setAllocationIdempotencyKey(newUuid())
  }

  function handleAllocate() {
    if (!allocatingTransfer) return
    const nextAllocations = buildAllocations(extraAllocationDraft)
    const total = nextAllocations.reduce((sum, allocation) => sum + allocation.amount, 0)
    if (nextAllocations.length === 0) {
      toast.error('请至少填写一笔分摊')
      return
    }
    if (total > transferAvailable(allocatingTransfer) + 0.005) {
      toast.error('分摊合计不能超过该转账可用余额')
      return
    }
    const needsCorrection = allocationsNeedCorrection(extraAllocationDraft)
    if (needsCorrection && !allocationCorrectionReason.trim()) {
      toast.error('分摊到历史已完成订单时必须填写修正原因')
      return
    }

    startTransition(async () => {
      const result = await allocateBusinessCustomerTransfer(allocatingTransfer.id, {
        allocations: nextAllocations,
        correction_reason: needsCorrection ? allocationCorrectionReason : '',
        idempotency_key: allocationIdempotencyKey,
      })
      if (!result.ok) {
        toast.error(result.error ?? '追加分摊失败')
        return
      }
      toast.success('转账分摊已更新')
      setAllocatingTransfer(null)
      setAllocationCorrectionReason('')
      setAllocationIdempotencyKey('')
      await loadData()
      router.refresh()
    })
  }

  function handleVoid() {
    if (!voidTarget || !voidReason.trim()) return
    startTransition(async () => {
      const result =
        voidTarget.kind === 'transfer'
          ? await voidBusinessCustomerTransfer(voidTarget.item.id, voidReason)
          : await voidBusinessOrderPaymentAllocation(voidTarget.item.id, voidReason)
      if (!result.ok) {
        toast.error(result.error ?? '作废失败')
        return
      }
      toast.success(voidTarget.kind === 'transfer' ? '客户转账已作废' : '收款分摊已作废')
      setVoidTarget(null)
      setVoidReason('')
      await loadData()
      router.refresh()
    })
  }

  function handleViewProof(transfer: BusinessCustomerTransfer) {
    startTransition(async () => {
      const supabase = createClient()
      const { data, error } = await supabase.storage
        .from('business-payment-proofs')
        .createSignedUrl(transfer.proof_path, 60 * 10)
      if (error || !data?.signedUrl) {
        toast.error('凭证打开失败')
        return
      }
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
    })
  }

  const allocatedDraftTotal = buildAllocations(allocationDraft).reduce(
    (sum, allocation) => sum + allocation.amount,
    0,
  )
  const unallocatedDraft = Math.max(amountValue(amount) - allocatedDraftTotal, 0)
  const transferAllocationNeedsCorrection = allocationsNeedCorrection(allocationDraft)
  const extraAllocationNeedsCorrection = allocationsNeedCorrection(extraAllocationDraft)
  const isOverdue = Boolean(
    settlement &&
      getBusinessOverdueDays(
        settlement.payment_due_date,
        settlement.payment_status === 'fully_paid',
      ) > 0,
  )

  return (
    <Card>
      <CardHeader className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base">客户转账与订单分摊</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              转账可分摊至同客户、同币种的多个订单，剩余金额自动保留为客户预收款。
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={loading || pending} onClick={() => void loadData()}>
              <RefreshCw className="h-4 w-4" />刷新
            </Button>
            {canManage && customerId && (
              <Button size="sm" onClick={openForm}>
                <Plus className="h-4 w-4" />登记客户转账
              </Button>
            )}
          </div>
        </div>

        {settlement && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">订单总额</div>
              <div className="mt-1 font-semibold tabular-nums">
                {formatCurrency(Number(settlement.total_amount), settlement.currency)}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">有效已收</div>
              <div className="mt-1 font-semibold tabular-nums text-green-700">
                {formatCurrency(Number(settlement.allocated_amount), settlement.currency)}
              </div>
            </div>
            <div className={`rounded-md border p-3 ${isOverdue ? 'border-destructive/50 bg-destructive/5' : ''}`}>
              <div className="text-xs text-muted-foreground">未收尾款</div>
              <div className="mt-1 font-semibold tabular-nums">
                {formatCurrency(Number(settlement.outstanding_amount), settlement.currency)}
              </div>
              {isOverdue && <div className="mt-1 text-xs font-medium text-destructive">已逾期，请尽快催收</div>}
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">客户预收余额</div>
              <div className="mt-1 font-semibold tabular-nums text-blue-700">
                {formatCurrency(prepayment, settlement.currency)}
              </div>
            </div>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {loading && <div className="py-8 text-center text-sm text-muted-foreground">正在读取收款数据…</div>}
        {loadError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {loadError}
          </div>
        )}
        {!loading && !loadError && currentAllocations.length === 0 && (
          <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
            当前订单暂无收款分摊
          </div>
        )}
        {!loading &&
          currentAllocations.map((allocation) => {
            const transfer = transferById.get(allocation.transfer_id)
            const effective = !allocation.voided_at && Boolean(transfer) && !transfer?.voided_at
            return (
              <div key={allocation.id} className="rounded-md border p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{paymentTypeLabel(allocation.payment_type)}</span>
                      <Badge variant={effective ? 'success' : 'secondary'}>{effective ? '有效' : '已作废'}</Badge>
                      {transfer?.voided_at && <Badge variant="destructive">所属转账已作废</Badge>}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {transfer ? formatDate(transfer.received_at, true) : '转账信息不可见'}
                      {transfer?.notes ? ` · ${transfer.notes}` : ''}
                    </div>
                    {(allocation.void_reason || transfer?.void_reason) && (
                      <div className="text-xs text-destructive">
                        作废原因：{allocation.void_reason || transfer?.void_reason}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 sm:justify-end">
                    <span className="font-semibold tabular-nums">
                      {formatCurrency(Number(allocation.amount), currency)}
                    </span>
                    {transfer && (
                      <Button variant="ghost" size="icon" disabled={pending} onClick={() => handleViewProof(transfer)} aria-label="查看凭证">
                        <Eye className="h-4 w-4" />
                      </Button>
                    )}
                    {canManage && !allocation.voided_at && !transfer?.voided_at && (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={pending}
                        onClick={() => {
                          setVoidReason('')
                          setVoidTarget({ kind: 'allocation', item: allocation })
                        }}
                        aria-label="作废分摊"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}

        {!loading && !loadError && transfers.length > 0 && (
          <div className="border-t pt-4">
            <h3 className="mb-3 text-sm font-medium">该客户的 {currency} 转账</h3>
            <div className="space-y-2">
              {transfers.map((transfer) => {
                const available = transferAvailable(transfer)
                const relatedAllocations = allocations.filter(
                  (allocation) => allocation.transfer_id === transfer.id,
                )
                return (
                  <div key={transfer.id} className="rounded-md border p-3 text-sm">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {formatCurrency(Number(transfer.amount), transfer.currency)} · {paymentTypeLabel(transfer.payment_type)}
                          </span>
                          <Badge variant={transfer.voided_at ? 'secondary' : 'success'}>
                            {transfer.voided_at ? '已作废' : '有效'}
                          </Badge>
                          {!transfer.voided_at && available > 0.005 && (
                            <Badge variant="outline">预收余额 {formatCurrency(available, transfer.currency)}</Badge>
                          )}
                        </div>
                        <div className="mt-1 text-muted-foreground">
                          {formatDate(transfer.received_at, true)} · 已分摊 {formatCurrency(transferAllocated(transfer.id), transfer.currency)}
                        </div>
                        {relatedAllocations.length > 0 && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {relatedAllocations.map((allocation) => {
                              const targetOrder = orderById.get(allocation.order_id)
                              return `${targetOrder?.order_number ?? '不可见订单'} ${formatCurrency(Number(allocation.amount), transfer.currency)}${allocation.voided_at ? '（已作废）' : ''}`
                            }).join('；')}
                          </div>
                        )}
                        {transfer.void_reason && <div className="mt-1 text-xs text-destructive">作废原因：{transfer.void_reason}</div>}
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" disabled={pending} onClick={() => handleViewProof(transfer)}>
                          <Eye className="h-4 w-4" />凭证
                        </Button>
                        {canManage && !transfer.voided_at && available > 0.005 && availableOrders.length > 0 && (
                          <Button variant="outline" size="sm" disabled={pending} onClick={() => openAllocation(transfer)}>
                            <WalletCards className="h-4 w-4" />使用预收款
                          </Button>
                        )}
                        {canManage && !transfer.voided_at && (
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={pending}
                            onClick={() => {
                              setVoidReason('')
                              setVoidTarget({ kind: 'transfer', item: transfer })
                            }}
                          >
                            作废转账
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </CardContent>

      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          if (open) setFormOpen(true)
          else if (!pending) closeForm()
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>登记客户转账</DialogTitle>
            <DialogDescription>分摊可以留空；未分摊金额将作为该客户的预收款。</DialogDescription>
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
                <Label htmlFor="transfer_amount">转账金额（{currency}）</Label>
                <Input id="transfer_amount" type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="transfer_rate">兑人民币汇率</Label>
                <Input id="transfer_rate" type="number" min="0.00000001" step="0.00000001" value={exchangeRate} onChange={(event) => setExchangeRate(event.target.value)} disabled={currency === 'CNY'} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="received_at">收款时间</Label>
                <Input id="received_at" type="datetime-local" value={receivedAt} onChange={(event) => setReceivedAt(event.target.value)} required />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="proof">收款截图（最大 5MB）</Label>
                <Input
                  ref={fileRef}
                  id="proof"
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                  required={!uploadedProofPath}
                  disabled={Boolean(uploadedProofPath)}
                />
                {uploadedProofPath && (
                  <p className="text-xs text-muted-foreground">
                    凭证已上传；再次提交会复用同一文件，关闭表单后可重新选择。
                  </p>
                )}
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="transfer_notes">备注</Label>
                <Textarea id="transfer_notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} />
              </div>
            </div>

            <div className="space-y-2 border-t pt-4">
              <div className="flex items-center justify-between">
                <Label>订单分摊（可选）</Label>
                <span className="text-xs text-muted-foreground">
                  分摊 {formatCurrency(allocatedDraftTotal, currency)} · 预收 {formatCurrency(unallocatedDraft, currency)}
                </span>
              </div>
              {availableOrders.map((order) => {
                const outstanding = Math.max(Number(order.total_amount) - (activePaidByOrder.get(order.id) ?? 0), 0)
                return (
                  <div key={order.id} className={`grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_180px] sm:items-center ${order.id === orderId ? 'border-primary/50' : ''}`}>
                    <div>
                      <div className="font-medium">{order.order_number}{order.id === orderId ? '（当前订单）' : ''}</div>
                      <div className="text-xs text-muted-foreground">未收 {formatCurrency(outstanding, currency)}</div>
                    </div>
                    <Input
                      aria-label={`${order.order_number} 分摊金额`}
                      type="number"
                      min="0"
                      max={outstanding}
                      step="0.01"
                      placeholder="分摊金额"
                      value={allocationDraft[order.id] ?? ''}
                      onChange={(event) => setAllocationDraft((current) => ({ ...current, [order.id]: event.target.value }))}
                    />
                  </div>
                )
              })}
              {availableOrders.length === 0 && <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">暂无可分摊订单，本次转账将全部计入预收款</div>}
            </div>

            {transferAllocationNeedsCorrection && (
              <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3">
                <Label htmlFor="transfer_correction_reason">历史完成订单修正原因（必填）</Label>
                <Textarea
                  id="transfer_correction_reason"
                  value={correctionReason}
                  onChange={(event) => setCorrectionReason(event.target.value)}
                  maxLength={1000}
                  required
                />
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeForm} disabled={pending}>取消</Button>
              <Button type="submit" disabled={pending || (transferAllocationNeedsCorrection && !correctionReason.trim())}>{pending ? '登记中…' : '登记转账'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(allocatingTransfer)}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setAllocatingTransfer(null)
            setAllocationCorrectionReason('')
            setAllocationIdempotencyKey('')
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>使用客户预收款</DialogTitle>
            <DialogDescription>
              可用余额 {allocatingTransfer ? formatCurrency(transferAvailable(allocatingTransfer), currency) : '—'}，可同时分摊到多个订单。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {availableOrders.map((order) => {
              const outstanding = Math.max(Number(order.total_amount) - (activePaidByOrder.get(order.id) ?? 0), 0)
              return (
                <div key={order.id} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_180px] sm:items-center">
                  <div>
                    <div className="font-medium">{order.order_number}{order.id === orderId ? '（当前订单）' : ''}</div>
                    <div className="text-xs text-muted-foreground">未收 {formatCurrency(outstanding, currency)}</div>
                  </div>
                  <Input
                    type="number"
                    min="0"
                    max={Math.min(outstanding, allocatingTransfer ? transferAvailable(allocatingTransfer) : 0)}
                    step="0.01"
                    placeholder="分摊金额"
                    value={extraAllocationDraft[order.id] ?? ''}
                    onChange={(event) => setExtraAllocationDraft((current) => ({ ...current, [order.id]: event.target.value }))}
                  />
                </div>
              )
            })}
          </div>
          {extraAllocationNeedsCorrection && (
            <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3">
              <Label htmlFor="allocation_correction_reason">历史完成订单修正原因（必填）</Label>
              <Textarea
                id="allocation_correction_reason"
                value={allocationCorrectionReason}
                onChange={(event) => setAllocationCorrectionReason(event.target.value)}
                maxLength={1000}
                required
              />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                setAllocatingTransfer(null)
                setAllocationCorrectionReason('')
                setAllocationIdempotencyKey('')
              }}
            >
              取消
            </Button>
            <Button
              disabled={pending || (extraAllocationNeedsCorrection && !allocationCorrectionReason.trim())}
              onClick={handleAllocate}
            >
              {pending ? '分摊中…' : '确认分摊'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(voidTarget)} onOpenChange={(open) => !open && setVoidTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{voidTarget?.kind === 'transfer' ? '作废客户转账' : '作废收款分摊'}</DialogTitle>
            <DialogDescription>
              记录会保留并显示为已作废；作废整笔转账将使其所有分摊失效。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="void_reason">作废原因（必填）</Label>
            <Textarea id="void_reason" value={voidReason} onChange={(event) => setVoidReason(event.target.value)} maxLength={1000} required />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVoidTarget(null)}>取消</Button>
            <Button variant="destructive" disabled={pending || !voidReason.trim()} onClick={handleVoid}>确认作废</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
