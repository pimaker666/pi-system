'use client'

import { FormEvent, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CustomerCombobox } from '@/components/customers/customer-combobox'
import {
  bindDailyOrderWorkflowCustomer,
  cancelDailyOrderChange,
  claimDailyOrderWorkflow,
  requestDailyOrderChange,
  reviewDailyOrderChange,
  reviewDailyOrderPerformance,
  saveDailyOrderCommission,
  submitDailyOrderPerformance,
} from '@/lib/actions/daily-order-workflow'
import {
  CHANGE_FIELD_LABELS,
  CHANGE_STATUS_LABELS,
  CHANGE_STATUS_VARIANTS,
  PAYMENT_LABELS,
  SHIPPING_LABELS,
  WORKFLOW_STATUS_LABELS,
  WORKFLOW_STATUS_VARIANTS,
  formatDailyMoney,
} from '@/lib/daily-orders'
import {
  dailyOrderCurrencies,
  dailyOrderPaymentCategories,
  dailyOrderShippingCategories,
} from '@/schemas/daily-order'
import { formatDate } from '@/lib/utils'
import type {
  Customer,
  CustomerGroup,
  DailyOrder,
  DailyOrderChangeRequest,
  DailyOrderCommission,
  DailyOrderWorkflow,
  Profile,
} from '@/types'

export interface DailyOrderWorkflowPanelProps {
  profile: Pick<Profile, 'id' | 'role'>
  workflow: DailyOrderWorkflow
  orders: DailyOrder[]
  changeRequests: DailyOrderChangeRequest[]
  customers: Customer[]
  groups: CustomerGroup[]
  commission: DailyOrderCommission | null
}

function formatChangeValue(key: string, value: string | number) {
  if (key === 'shipping_category') return SHIPPING_LABELS[value as keyof typeof SHIPPING_LABELS] ?? String(value)
  if (key === 'payment_category') return PAYMENT_LABELS[value as keyof typeof PAYMENT_LABELS] ?? String(value)
  return String(value)
}

export function DailyOrderWorkflowPanel({
  profile,
  workflow,
  orders,
  changeRequests,
  customers,
  groups,
  commission,
}: DailyOrderWorkflowPanelProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const isOwnerSales = profile.role === 'sales' && workflow.salesperson_id === profile.id
  const isFinance = profile.role === 'admin' || profile.role === 'finance'
  const { status } = workflow

  const canClaim = isOwnerSales && status === 'unclaimed'
  const canBind = (isOwnerSales || isFinance) && status !== 'unclaimed' && status !== 'approved'
  const canSubmit = isOwnerSales && (status === 'claimed' || status === 'rejected') && !!workflow.customer_id
  const canReviewPerformance = isFinance && status === 'submitted'
  const canCommission = isFinance && status === 'approved'
  const canRequestChange = isOwnerSales && status !== 'unclaimed'

  const selectedCustomer = workflow.customer_id
    ? customers.find((c) => c.id === workflow.customer_id) ?? null
    : null
  const [customerDraft, setCustomerDraft] = useState<Customer | null>(selectedCustomer)

  // Reject-performance dialog
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  // Commission form
  const [commissionAmount, setCommissionAmount] = useState(
    commission ? String(commission.commission_amount) : '',
  )
  const [commissionCurrency, setCommissionCurrency] = useState<string>(
    commission?.commission_currency ?? 'CNY',
  )
  const [commissionRemarks, setCommissionRemarks] = useState(commission?.remarks ?? '')

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    startTransition(async () => {
      const result = await fn()
      if (result.ok) {
        toast.success(success)
        router.refresh()
      } else {
        toast.error(result.error ?? '操作失败')
      }
    })
  }

  const handleClaim = () =>
    run(
      () => claimDailyOrderWorkflow({ workflowId: workflow.id, expectedVersion: workflow.version }),
      '认领成功',
    )

  const handleBind = () => {
    if (!customerDraft) {
      toast.error('请选择客户')
      return
    }
    run(
      () =>
        bindDailyOrderWorkflowCustomer({
          workflowId: workflow.id,
          expectedVersion: workflow.version,
          customerId: customerDraft.id,
        }),
      '客户绑定成功',
    )
  }

  const handleSubmit = () =>
    run(
      () =>
        submitDailyOrderPerformance({
          workflowId: workflow.id,
          expectedVersion: workflow.version,
        }),
      '已提交业绩审核',
    )

  const handleApprove = () =>
    run(
      () =>
        reviewDailyOrderPerformance({
          workflowId: workflow.id,
          expectedVersion: workflow.version,
          approve: true,
        }),
      '业绩已通过',
    )

  const handleReject = () => {
    run(
      () =>
        reviewDailyOrderPerformance({
          workflowId: workflow.id,
          expectedVersion: workflow.version,
          approve: false,
          reason: rejectReason,
        }),
      '业绩已驳回',
    )
    setRejectOpen(false)
    setRejectReason('')
  }

  const handleCommission = (event: FormEvent) => {
    event.preventDefault()
    run(
      () =>
        saveDailyOrderCommission({
          workflowId: workflow.id,
          commissionAmount,
          commissionCurrency,
          remarks: commissionRemarks,
        }),
      '提成已保存',
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">订单 {workflow.order_number}</CardTitle>
          <Badge variant={WORKFLOW_STATUS_VARIANTS[status]}>{WORKFLOW_STATUS_LABELS[status]}</Badge>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">业务员：</span>
              {workflow.salesperson_name_snapshot || '—'}
            </div>
            <div>
              <span className="text-muted-foreground">客户：</span>
              {workflow.customer_name_snapshot || '未绑定'}
            </div>
            <div>
              <span className="text-muted-foreground">认领时间：</span>
              {workflow.claimed_at ? formatDate(workflow.claimed_at) : '—'}
            </div>
            <div>
              <span className="text-muted-foreground">提交时间：</span>
              {workflow.submitted_at ? formatDate(workflow.submitted_at) : '—'}
            </div>
          </div>
          {status === 'rejected' && workflow.review_reason && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
              驳回原因：{workflow.review_reason}
            </p>
          )}
        </CardContent>
      </Card>

      {(canClaim || canBind || canSubmit || canReviewPerformance) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">工作流操作</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {canClaim && (
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">认领后即可绑定客户并提交业绩审核。</p>
                <Button onClick={handleClaim} disabled={pending}>
                  认领订单
                </Button>
              </div>
            )}

            {canBind && (
              <div className="space-y-2">
                <Label>绑定客户（必填）</Label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="flex-1">
                    <CustomerCombobox
                      customers={customers}
                      groups={groups}
                      value={customerDraft}
                      onChange={setCustomerDraft}
                    />
                  </div>
                  <Button onClick={handleBind} disabled={pending} variant="secondary">
                    保存客户
                  </Button>
                </div>
              </div>
            )}

            {canSubmit && (
              <div className="flex items-center justify-between gap-3 border-t pt-4">
                <p className="text-sm text-muted-foreground">
                  确认订单信息与客户无误后，提交给财务或管理员审核业绩。
                </p>
                <Button onClick={handleSubmit} disabled={pending}>
                  提交业绩审核
                </Button>
              </div>
            )}

            {canReviewPerformance && (
              <div className="flex items-center justify-between gap-3 border-t pt-4">
                <p className="text-sm text-muted-foreground">审核该订单业绩，通过后可录入提成。</p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setRejectOpen(true)}
                    disabled={pending}
                  >
                    驳回
                  </Button>
                  <Button onClick={handleApprove} disabled={pending}>
                    通过
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isFinance && (canCommission || commission) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">提成（仅财务/管理员可见）</CardTitle>
          </CardHeader>
          <CardContent>
            {canCommission ? (
              <form onSubmit={handleCommission} className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="commission-amount">提成金额</Label>
                    <Input
                      id="commission-amount"
                      value={commissionAmount}
                      onChange={(e) => setCommissionAmount(e.target.value)}
                      placeholder="0.00"
                      inputMode="decimal"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>币种</Label>
                    <Select value={commissionCurrency} onValueChange={setCommissionCurrency}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {dailyOrderCurrencies.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="commission-remarks">备注</Label>
                  <Textarea
                    id="commission-remarks"
                    value={commissionRemarks}
                    onChange={(e) => setCommissionRemarks(e.target.value)}
                    rows={2}
                  />
                </div>
                <Button type="submit" disabled={pending}>
                  保存提成
                </Button>
              </form>
            ) : (
              commission && (
                <p className="text-sm">
                  {formatDailyMoney(commission.commission_amount, commission.commission_currency)}
                  {commission.remarks ? ` · ${commission.remarks}` : ''}
                </p>
              )
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">订单明细</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>产品</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead className="text-right">销售单价</TableHead>
                  <TableHead className="text-right">销售总金额</TableHead>
                  <TableHead>发货分类</TableHead>
                  <TableHead>收款分类</TableHead>
                  <TableHead>改动 / 操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((order) => {
                  const orderChanges = changeRequests.filter((cr) => cr.order_id === order.id)
                  const pendingChange = orderChanges.find((cr) => cr.status === 'pending') ?? null
                  return (
                    <TableRow key={order.id}>
                      <TableCell>
                        <div className="font-medium">{order.product_name_snapshot}</div>
                        <div className="text-xs text-muted-foreground">{order.product_sku_snapshot}</div>
                      </TableCell>
                      <TableCell className="text-right">{order.quantity}</TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        {formatDailyMoney(order.sales_unit_price_amount, order.sales_unit_price_currency)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        {formatDailyMoney(order.sales_total_amount, order.sales_total_currency)}
                      </TableCell>
                      <TableCell>{SHIPPING_LABELS[order.shipping_category]}</TableCell>
                      <TableCell>{PAYMENT_LABELS[order.payment_category]}</TableCell>
                      <TableCell className="space-y-2">
                        {pendingChange ? (
                          <PendingChangeCell
                            profile={profile}
                            change={pendingChange}
                            disabled={pending}
                            run={run}
                          />
                        ) : (
                          canRequestChange && (
                            <ChangeRequestDialog
                              order={order}
                              disabled={pending}
                              run={run}
                            />
                          )
                        )}
                        {orderChanges
                          .filter((cr) => cr.status !== 'pending')
                          .slice(0, 3)
                          .map((cr) => (
                            <div key={cr.id} className="text-xs text-muted-foreground">
                              <Badge variant={CHANGE_STATUS_VARIANTS[cr.status]} className="mr-1">
                                {CHANGE_STATUS_LABELS[cr.status]}
                              </Badge>
                              {cr.review_reason ? `原因：${cr.review_reason}` : formatDate(cr.requested_at)}
                            </div>
                          ))}
                      </TableCell>
                    </TableRow>
                  )
                })}
                {orders.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                      暂无订单明细
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>驳回业绩审核</DialogTitle>
            <DialogDescription>请填写驳回原因，业务员可据此修改后重新提交。</DialogDescription>
          </DialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="驳回原因"
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)} disabled={pending}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={pending || rejectReason.trim().length === 0}
            >
              确认驳回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

type RunFn = (
  fn: () => Promise<{ ok: boolean; error?: string }>,
  success: string,
) => void

function PendingChangeCell({
  profile,
  change,
  disabled,
  run,
}: {
  profile: Pick<Profile, 'id' | 'role'>
  change: DailyOrderChangeRequest
  disabled: boolean
  run: RunFn
}) {
  const isFinance = profile.role === 'admin' || profile.role === 'finance'
  const isRequester = change.requested_by === profile.id
  const [rejectOpen, setRejectOpen] = useState(false)
  const [reason, setReason] = useState('')

  return (
    <div className="space-y-2">
      <div className="rounded-md border bg-muted/40 px-2 py-1.5 text-xs">
        <Badge variant="default" className="mb-1">待审改动</Badge>
        <ul className="space-y-0.5">
          {Object.entries(change.payload).map(([key, value]) => (
            <li key={key}>
              <span className="text-muted-foreground">{CHANGE_FIELD_LABELS[key] ?? key}：</span>
              {formatChangeValue(key, value)}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex gap-2">
        {isFinance && (
          <>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() =>
                run(
                  () => reviewDailyOrderChange({ changeId: change.id, approve: true }),
                  '改动已通过',
                )
              }
            >
              通过
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setRejectOpen(true)}
            >
              驳回
            </Button>
          </>
        )}
        {isRequester && (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              run(() => cancelDailyOrderChange({ changeId: change.id }), '改动申请已撤销')
            }
          >
            撤销
          </Button>
        )}
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>驳回改动申请</DialogTitle>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="驳回原因"
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)} disabled={disabled}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={disabled || reason.trim().length === 0}
              onClick={() => {
                run(
                  () => reviewDailyOrderChange({ changeId: change.id, approve: false, reason }),
                  '改动已驳回',
                )
                setRejectOpen(false)
                setReason('')
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

const CHANGE_FIELDS = [
  { key: 'shipping_date', label: '发货日期', type: 'date' },
  { key: 'shipping_number', label: '发货单号', type: 'text' },
  { key: 'shipping_category', label: '发货分类', type: 'shipping' },
  { key: 'quantity', label: '数量', type: 'number' },
  { key: 'sales_unit_price_amount', label: '销售单价', type: 'number' },
  { key: 'sales_unit_price_currency', label: '销售单价币种', type: 'currency' },
  { key: 'product_received_amount', label: '产品实收金额', type: 'number' },
  { key: 'product_received_currency', label: '产品实收币种', type: 'currency' },
  { key: 'logistics_fee_amount', label: '物流费用', type: 'number' },
  { key: 'logistics_fee_currency', label: '物流费用币种', type: 'currency' },
  { key: 'sales_total_amount', label: '销售总金额', type: 'number' },
  { key: 'sales_total_currency', label: '销售总金额币种', type: 'currency' },
  { key: 'payment_category', label: '收款分类', type: 'payment' },
  { key: 'remarks', label: '备注', type: 'textarea' },
] as const

function orderFieldValue(order: DailyOrder, key: string): string {
  const value = (order as unknown as Record<string, unknown>)[key]
  return value === null || value === undefined ? '' : String(value)
}

function ChangeRequestDialog({
  order,
  disabled,
  run,
}: {
  order: DailyOrder
  disabled: boolean
  run: RunFn
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(CHANGE_FIELDS.map((f) => [f.key, orderFieldValue(order, f.key)])),
  )

  const submit = () => {
    const payload: Record<string, string | number> = {}
    for (const field of CHANGE_FIELDS) {
      const next = (draft[field.key] ?? '').trim()
      const current = orderFieldValue(order, field.key).trim()
      if (next === current) continue
      if (field.type === 'number') {
        if (next === '') continue
        payload[field.key] = Number(next)
      } else {
        payload[field.key] = next
      }
    }
    if (Object.keys(payload).length === 0) {
      toast.error('请至少修改一个字段')
      return
    }
    run(() => requestDailyOrderChange({ orderId: order.id, payload }), '改动申请已提交')
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
        申请改动
      </Button>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>申请修改订单信息</DialogTitle>
          <DialogDescription>
            修改的字段需经财务或管理员审核通过后才会生效，客户归属不可在此修改。
          </DialogDescription>
        </DialogHeader>
        <div className="border-t" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {CHANGE_FIELDS.map((field) => (
            <div key={field.key} className="space-y-1">
              <Label>{field.label}</Label>
              {field.type === 'shipping' ? (
                <Select
                  value={draft[field.key]}
                  onValueChange={(v) => setDraft((d) => ({ ...d, [field.key]: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {dailyOrderShippingCategories.map((c) => (
                      <SelectItem key={c} value={c}>
                        {SHIPPING_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : field.type === 'payment' ? (
                <Select
                  value={draft[field.key]}
                  onValueChange={(v) => setDraft((d) => ({ ...d, [field.key]: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {dailyOrderPaymentCategories.map((c) => (
                      <SelectItem key={c} value={c}>
                        {PAYMENT_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : field.type === 'currency' ? (
                <Select
                  value={draft[field.key]}
                  onValueChange={(v) => setDraft((d) => ({ ...d, [field.key]: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {dailyOrderCurrencies.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : field.type === 'textarea' ? (
                <Textarea
                  value={draft[field.key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))}
                  rows={2}
                />
              ) : (
                <Input
                  type={field.type === 'date' ? 'date' : 'text'}
                  inputMode={field.type === 'number' ? 'decimal' : undefined}
                  value={draft[field.key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))}
                />
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={disabled}>
            取消
          </Button>
          <Button onClick={submit} disabled={disabled}>
            提交申请
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
