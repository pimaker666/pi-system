import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import {
  BusinessOrderActions,
  BusinessOrderFinancePanel,
} from '@/components/finance/business-order-actions'
import { BusinessOrderPaymentManager } from '@/components/finance/business-order-payment-manager'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { requireApproved } from '@/lib/auth'
import {
  BUSINESS_FULFILLMENT_LABELS,
  BUSINESS_ORDER_STATUS_LABELS,
  BUSINESS_ORDER_STATUS_VARIANTS,
  getBusinessOrderCustomerName,
} from '@/lib/business-orders'
import { formatCny } from '@/lib/finance'
import { createClient } from '@/lib/supabase/server'
import { formatCurrency, formatDate } from '@/lib/utils'
import type {
  BusinessAuditAction,
  BusinessOrderAuditLog,
  BusinessOrderFinanceDetail,
  BusinessOrderWithDetails,
} from '@/types'

const auditLabels: Record<BusinessAuditAction, string> = {
  create: '创建订单',
  update: '修改订单',
  payment_add: '新增收款',
  payment_update: '修改收款',
  payment_void: '作废收款',
  submit: '提交审核',
  approve: '审核通过',
  reject: '驳回订单',
  finance_update: '更新财务核算',
  complete: '完成订单',
  correct: '修正已完成订单',
}

export default async function BusinessOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const profile = await requireApproved()
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('business_orders')
    .select('*, business_order_items(*), business_order_payments(*)')
    .eq('id', id)
    .single()

  if (error || !data) notFound()
  const order = data as BusinessOrderWithDetails
  order.business_order_items.sort((a, b) => a.sort_order - b.sort_order)
  order.business_order_payments.sort(
    (a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime(),
  )

  let auditLogs: BusinessOrderAuditLog[] = []
  let financeDetail: BusinessOrderFinanceDetail | null = null
  if (profile.role === 'admin' || profile.role === 'finance') {
    const [auditResult, financeResult] = await Promise.all([
      supabase
        .from('business_order_audit_logs')
        .select('*')
        .eq('order_id', id)
        .order('created_at', { ascending: false }),
      supabase
        .from('business_order_finance_details')
        .select('*')
        .eq('order_id', id)
        .maybeSingle(),
    ])
    if (auditResult.error) throw new Error(`审计记录读取失败：${auditResult.error.message}`)
    if (financeResult.error) throw new Error(`财务核算读取失败：${financeResult.error.message}`)
    auditLogs = (auditResult.data ?? []) as BusinessOrderAuditLog[]
    financeDetail = financeResult.data as BusinessOrderFinanceDetail | null
  }

  const customer = order.customer_snapshot

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon" className="h-8 w-8">
            <Link href="/finance/performance"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{order.order_number}</h1>
              <Badge variant={BUSINESS_ORDER_STATUS_VARIANTS[order.status]}>
                {BUSINESS_ORDER_STATUS_LABELS[order.status]}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {formatDate(order.order_date)} · {BUSINESS_FULFILLMENT_LABELS[order.fulfillment_type]}
            </p>
          </div>
        </div>
        <BusinessOrderActions order={order} profile={profile} />
      </div>

      {order.review_note && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <span className="font-medium">审核说明：</span>{order.review_note}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle className="text-base">客户与订单</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="font-medium">{getBusinessOrderCustomerName(customer)}</div>
              {customer.contact_person && <div>联系人：{customer.contact_person}</div>}
              {customer.email && <div className="text-muted-foreground">{customer.email}</div>}
              {customer.phone && <div className="text-muted-foreground">{customer.phone}</div>}
              {customer.address && <div className="text-muted-foreground">{customer.address}</div>}
              <div className="border-t pt-2">
                <span className="text-muted-foreground">业务员：</span>
                {order.salesperson_name_snapshot || '—'}
              </div>
              <div>
                <span className="text-muted-foreground">货运单号：</span>
                {order.tracking_number || '—'}
              </div>
              <div>
                <span className="text-muted-foreground">业务备注：</span>
                {order.sales_notes || '—'}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">金额</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">产品小计</span><span>{formatCurrency(Number(order.items_subtotal), order.currency)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">运费</span><span>{formatCurrency(Number(order.shipping_fee), order.currency)}</span></div>
              <div className="flex justify-between border-t pt-2 text-base font-semibold"><span>订单总额</span><span>{formatCurrency(Number(order.total_amount), order.currency)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">兑人民币汇率</span><span>{Number(order.exchange_rate_to_cny).toLocaleString('zh-CN', { maximumFractionDigits: 8 })}</span></div>
              <div className="flex justify-between font-medium"><span>折合人民币</span><span>{formatCny(Number(order.total_cny))}</span></div>
            </CardContent>
          </Card>

          {(profile.role === 'admin' || profile.role === 'finance') && (
            <BusinessOrderFinancePanel
              order={order}
              financeDetail={financeDetail}
              role={profile.role}
            />
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle className="text-base">产品明细</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>产品</TableHead>
                    <TableHead className="text-right">数量</TableHead>
                    <TableHead className="text-right">成交单价</TableHead>
                    <TableHead className="text-right">金额</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {order.business_order_items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="font-medium">{item.name_snapshot}</div>
                        <div className="text-xs text-muted-foreground">{item.sku_snapshot} · {item.specification_snapshot || item.unit_snapshot}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{Number(item.quantity).toLocaleString('zh-CN')}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(Number(item.unit_price), order.currency)}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{formatCurrency(Number(item.line_amount), order.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <BusinessOrderPaymentManager
            orderId={order.id}
            currency={order.currency}
            status={order.status}
            profile={profile}
            payments={order.business_order_payments}
          />

          {(profile.role === 'admin' || profile.role === 'finance') && (
            <Card>
              <CardHeader><CardTitle className="text-base">审计记录</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {auditLogs.map((log) => (
                  <div key={log.id} className="border-l-2 pl-3 text-sm">
                    <div className="font-medium">{auditLabels[log.action]}</div>
                    <div className="text-muted-foreground">
                      {log.actor_snapshot.full_name || log.actor_snapshot.email || '未知用户'} · {formatDate(log.created_at, true)}
                    </div>
                    {log.reason && <div className="mt-1">说明：{log.reason}</div>}
                  </div>
                ))}
                {auditLogs.length === 0 && <div className="text-sm text-muted-foreground">暂无审计记录</div>}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
