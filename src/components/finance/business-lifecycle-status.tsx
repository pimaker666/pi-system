import { CalendarClock, CircleDollarSign, ClipboardCheck, PackageCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  BUSINESS_APPROVAL_STATUS_LABELS,
  BUSINESS_APPROVAL_STATUS_VARIANTS,
  BUSINESS_FULFILLMENT_STATUS_LABELS,
  BUSINESS_FULFILLMENT_STATUS_VARIANTS,
  BUSINESS_PAYMENT_STATUS_LABELS,
  BUSINESS_PAYMENT_STATUS_VARIANTS,
  getBusinessOverdueDays,
} from '@/lib/business-orders'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { BusinessOrder, BusinessOrderSettlementSummary } from '@/types'

interface BusinessLifecycleStatusProps {
  order: Pick<
    BusinessOrder,
    'approval_status' | 'payment_due_date' | 'status' | 'completion_gate_version'
  >
  summary: BusinessOrderSettlementSummary
}

function getDueStatus(dueDate: string | null, fullyPaid: boolean) {
  if (!dueDate) return { label: '未设置到期日', overdue: false }

  const overdueDays = getBusinessOverdueDays(dueDate, fullyPaid)
  if (overdueDays > 0) {
    return { label: `已逾期 ${overdueDays} 天`, overdue: true }
  }

  return { label: `到期日 ${formatDate(dueDate)}`, overdue: false }
}

export function BusinessLifecycleStatus({ order, summary }: BusinessLifecycleStatusProps) {
  const fullyPaid = summary.payment_status === 'fully_paid'
  const dueStatus = getDueStatus(order.payment_due_date ?? summary.payment_due_date, fullyPaid)
  const isLegacyCompleted = order.status === 'completed' && order.completion_gate_version < 2

  const statuses = [
    {
      key: 'approval',
      title: '审核',
      icon: ClipboardCheck,
      label: BUSINESS_APPROVAL_STATUS_LABELS[order.approval_status],
      variant: BUSINESS_APPROVAL_STATUS_VARIANTS[order.approval_status],
      detail: order.approval_status === 'approved' ? '审核门禁已满足' : '需审核通过后才能继续履约',
    },
    {
      key: 'payment',
      title: '收款',
      icon: CircleDollarSign,
      label: BUSINESS_PAYMENT_STATUS_LABELS[summary.payment_status],
      variant: BUSINESS_PAYMENT_STATUS_VARIANTS[summary.payment_status],
      detail: `总实收 ${formatCurrency(Number(summary.allocated_amount), summary.currency)} · 未收尾款 ${formatCurrency(Number(summary.outstanding_amount), summary.currency)}`,
    },
    {
      key: 'fulfillment',
      title: '发货',
      icon: PackageCheck,
      label: isLegacyCompleted
        ? '历史完成'
        : BUSINESS_FULFILLMENT_STATUS_LABELS[summary.fulfillment_status],
      variant: isLegacyCompleted
        ? 'secondary'
        : BUSINESS_FULFILLMENT_STATUS_VARIANTS[summary.fulfillment_status],
      detail: isLegacyCompleted
        ? '历史订单未追溯逐产品发货记录'
        : `${Number(summary.shipped_quantity).toLocaleString('zh-CN')} / ${Number(summary.item_quantity).toLocaleString('zh-CN')}`,
    },
  ] as const

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">订单生命周期</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {statuses.map((status) => {
            const Icon = status.icon
            return (
              <div key={status.key} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    {status.title}
                  </div>
                  <Badge variant={status.variant}>{status.label}</Badge>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{status.detail}</p>
              </div>
            )
          })}
        </div>

        <div
          className={`flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:justify-between ${
            dueStatus.overdue ? 'border-destructive/40 bg-destructive/5' : ''
          }`}
        >
          <div>
            <span className="text-muted-foreground">订单应收：</span>
            <span className="font-medium tabular-nums">
              {formatCurrency(Number(summary.total_amount), summary.currency)}
            </span>
            <span className="ml-3 text-muted-foreground">总实收金额：</span>
            <span className="font-medium tabular-nums">
              {formatCurrency(Number(summary.allocated_amount), summary.currency)}
            </span>
            <span className="ml-3 text-muted-foreground">未收尾款：</span>
            <span className="font-medium tabular-nums">
              {formatCurrency(Number(summary.outstanding_amount), summary.currency)}
            </span>
          </div>
          <div
            className={`flex items-center gap-1.5 ${
              dueStatus.overdue ? 'font-medium text-destructive' : 'text-muted-foreground'
            }`}
          >
            <CalendarClock className="h-4 w-4" />
            {dueStatus.label}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
