import Image from 'next/image'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import {
  BusinessOrderActions,
  BusinessOrderFinancePanel,
} from '@/components/finance/business-order-actions'
import { BusinessLifecycleStatus } from '@/components/finance/business-lifecycle-status'
import { BusinessOrderPaymentManager } from '@/components/finance/business-order-payment-manager'
import {
  BusinessReturnManager,
  type BusinessOrderReturnView,
} from '@/components/finance/business-return-manager'
import { BusinessShipmentManager } from '@/components/finance/business-shipment-manager'
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
import { getBusinessOrderSettlementSummary } from '@/lib/actions/business-orders'
import { requireApproved } from '@/lib/auth'
import {
  BUSINESS_FULFILLMENT_LABELS,
  BUSINESS_ORDER_STATUS_LABELS,
  BUSINESS_ORDER_STATUS_VARIANTS,
  getBusinessOrderCustomerName,
} from '@/lib/business-orders'
import { formatCny } from '@/lib/finance'
import { toImageSrc } from '@/lib/supabase/image'
import { createClient } from '@/lib/supabase/server'
import { formatCurrency, formatDate, displayProfileName } from '@/lib/utils'
import type {
  BusinessLifecycleAuditLog,
  BusinessOrderAuditLog,
  BusinessOrderFinanceDetail,
  BusinessOrderWithDetails,
} from '@/types'

const auditLabels: Record<string, string> = {
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
  special_close: '特殊关闭订单',
  close: '特殊关闭订单',
}

const lifecycleEntityLabels: Record<string, string> = {
  custom_product: '定制产品',
  custom_product_version: '定制产品版本',
  transfer: '客户转账',
  allocation: '收款分摊',
  shipment: '发货批次',
  return: '退货记录',
  order_return: '退货记录',
  closure: '特殊关闭',
}

const lifecycleActionLabels: Record<string, string> = {
  create: '创建',
  version_create: '创建版本',
  state_change: '变更状态',
  void: '作废',
  close: '关闭',
  special_close: '特殊关闭',
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
    .select(
      '*, business_order_items(*), business_order_payments(*), business_order_shipments(*, business_order_shipment_items(*)), business_order_returns(*, business_order_return_items(*)), salesperson:profiles!salesperson_id(id, chinese_name, full_name, email)',
    )
    .eq('id', id)
    .single()

  if (error || !data) notFound()
  const order = data as BusinessOrderWithDetails & {
    closed_at?: string | null
    closed_by?: string | null
    close_reason?: string | null
    closure_reason?: string | null
    business_order_returns?: BusinessOrderReturnView[]
  }
  order.business_order_items.sort((a, b) => a.sort_order - b.sort_order)
  order.business_order_payments.sort(
    (a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime(),
  )
  const shipments = (order.business_order_shipments ?? []).sort(
    (a, b) => new Date(b.shipped_at).getTime() - new Date(a.shipped_at).getTime(),
  )
  const shipmentItems = shipments.flatMap((shipment) => shipment.business_order_shipment_items)
  const returns = (order.business_order_returns ?? []).sort(
    (a, b) => new Date(b.returned_at).getTime() - new Date(a.returned_at).getTime(),
  )
  const returnItems = returns.flatMap(
    (returnRecord) => returnRecord.business_order_return_items ?? [],
  )
  const settlementResult = await getBusinessOrderSettlementSummary(order.id)
  if (!settlementResult.ok || !settlementResult.data) {
    throw new Error(settlementResult.error ?? '订单结算汇总读取失败')
  }
  const settlement = settlementResult.data

  let auditLogs: BusinessOrderAuditLog[] = []
  let lifecycleAuditLogs: BusinessLifecycleAuditLog[] = []
  let financeDetail: BusinessOrderFinanceDetail | null = null
  if (profile.role === 'admin' || profile.role === 'finance') {
    const allocationResult = await supabase
      .from('business_order_payment_allocations')
      .select('transfer_id')
      .eq('order_id', id)
    if (allocationResult.error) {
      throw new Error(`订单关联转账读取失败：${allocationResult.error.message}`)
    }
    const transferIds = [...new Set(
      (allocationResult.data ?? [])
        .map((allocation) => allocation.transfer_id as string | null)
        .filter((transferId): transferId is string => Boolean(transferId)),
    )]

    const [auditResult, lifecycleAuditResult, transferAuditResult, financeResult] = await Promise.all([
      supabase
        .from('business_order_audit_logs')
        .select('*, actor:profiles!actor_id(id, chinese_name, full_name, email)')
        .eq('order_id', id)
        .order('created_at', { ascending: false }),
      supabase
        .from('business_lifecycle_audit_logs')
        .select('*, actor:profiles!actor_id(id, chinese_name, full_name, email)')
        .eq('order_id', id)
        .order('created_at', { ascending: false }),
      transferIds.length > 0
        ? supabase
            .from('business_lifecycle_audit_logs')
            .select('*, actor:profiles!actor_id(id, chinese_name, full_name, email)')
            .is('order_id', null)
            .eq('entity_type', 'transfer')
            .in('entity_id', transferIds)
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      supabase
        .from('business_order_finance_details')
        .select('*')
        .eq('order_id', id)
        .maybeSingle(),
    ])
    if (auditResult.error) throw new Error(`订单审计记录读取失败：${auditResult.error.message}`)
    if (lifecycleAuditResult.error || transferAuditResult.error) {
      throw new Error(
        `生命周期审计记录读取失败：${lifecycleAuditResult.error?.message ?? transferAuditResult.error?.message}`,
      )
    }
    if (financeResult.error) throw new Error(`财务核算读取失败：${financeResult.error.message}`)
    auditLogs = (auditResult.data ?? []) as BusinessOrderAuditLog[]
    lifecycleAuditLogs = [
      ...((lifecycleAuditResult.data ?? []) as BusinessLifecycleAuditLog[]),
      ...((transferAuditResult.data ?? []) as BusinessLifecycleAuditLog[]),
    ]
      .filter((log, index, all) => all.findIndex((candidate) => candidate.id === log.id) === index)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    financeDetail = financeResult.data as BusinessOrderFinanceDetail | null
  }

  const customer = order.customer_snapshot
  const financeReady = Boolean(
    financeDetail &&
      Number(financeDetail.wage_amount_cny) >= 0 &&
      financeDetail.calculation_notes.trim(),
  )
  const mergedAuditLogs = [
    ...auditLogs.map((log) => ({ kind: 'order' as const, log })),
    ...lifecycleAuditLogs.map((log) => ({ kind: 'lifecycle' as const, log })),
  ].sort((a, b) => new Date(b.log.created_at).getTime() - new Date(a.log.created_at).getTime())

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon" className="h-8 w-8">
            <Link href="/finance/daily-orders"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{order.order_number}</h1>
              {order.closed_at ? (
                <Badge variant="secondary">特殊关闭</Badge>
              ) : (
                <Badge variant={BUSINESS_ORDER_STATUS_VARIANTS[order.status]}>
                  {BUSINESS_ORDER_STATUS_LABELS[order.status]}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {formatDate(order.order_date)} · {BUSINESS_FULFILLMENT_LABELS[order.fulfillment_type]}
            </p>
          </div>
        </div>
        <BusinessOrderActions order={order} profile={profile} financeReady={financeReady} />
      </div>

      {order.review_note && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <span className="font-medium">审核说明：</span>{order.review_note}
        </div>
      )}

      {order.closed_at && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          <div className="font-medium">此订单已特殊关闭</div>
          <div className="mt-1">
            关闭时间：{formatDate(order.closed_at, true)} · 原因：
            {order.close_reason || order.closure_reason || '—'}
          </div>
          <div className="mt-1 text-amber-800">
            以下审批、收款、发货及退货状态均按实际记录展示，不视为正常完成。
          </div>
        </div>
      )}

      <BusinessLifecycleStatus order={order} summary={settlement} />

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
                {displayProfileName(
                  order.salesperson,
                  order.salesperson_display_name_snapshot ?? order.salesperson_name_snapshot,
                )}
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
                        <div className="flex items-center gap-3">
                          {item.image_url_snapshot ? (
                            <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md border bg-muted">
                              <Image
                                src={toImageSrc(item.image_url_snapshot)}
                                alt={item.name_snapshot}
                                fill
                                className="object-cover"
                                sizes="48px"
                              />
                            </div>
                          ) : (
                            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border bg-muted text-[10px] text-muted-foreground">
                              无图片
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="font-medium">{item.name_snapshot}</div>
                            <div className="text-xs text-muted-foreground">
                              {item.sku_snapshot} · {item.specification_snapshot || item.unit_snapshot}
                            </div>
                          </div>
                        </div>
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

          {['admin', 'finance', 'sales', 'supervisor'].includes(profile.role) && (
            <BusinessOrderPaymentManager
              orderId={order.id}
              ownerId={order.salesperson_id}
              currency={order.currency}
              status={order.closed_at ? 'completed' : order.status}
              completionGateVersion={order.closed_at ? 2 : order.completion_gate_version}
              profile={profile}
              payments={order.business_order_payments}
            />
          )}

          <BusinessShipmentManager
            order={order}
            profile={profile}
            orderItems={order.business_order_items}
            shipments={shipments}
            shipmentItems={shipmentItems}
            returns={returns}
            returnItems={returnItems}
          />

          <BusinessReturnManager
            order={order}
            profile={profile}
            orderItems={order.business_order_items}
            shipments={shipments}
            shipmentItems={shipmentItems}
            returns={returns}
          />

          {(profile.role === 'admin' || profile.role === 'finance') && (
            <Card>
              <CardHeader><CardTitle className="text-base">审计记录</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {mergedAuditLogs.map(({ kind, log }) => (
                  <div
                    key={`${kind}-${log.id}`}
                    className={
                      kind === 'lifecycle'
                        ? 'border-l-2 border-blue-300 pl-3 text-sm'
                        : 'border-l-2 pl-3 text-sm'
                    }
                  >
                    <div className="font-medium">
                      {kind === 'order'
                        ? auditLabels[log.action] ?? log.action
                        : `${lifecycleEntityLabels[log.entity_type] ?? log.entity_type} · ${lifecycleActionLabels[log.action] ?? log.action}`}
                    </div>
                    <div className="text-muted-foreground">
                      {displayProfileName(
                        log.actor,
                        log.actor_display_name_snapshot ||
                          log.actor_snapshot.full_name ||
                          log.actor_snapshot.email,
                      )}{' '}
                      · {formatDate(log.created_at, true)}
                    </div>
                    {log.reason && <div className="mt-1">说明：{log.reason}</div>}
                  </div>
                ))}
                {mergedAuditLogs.length === 0 && (
                  <div className="text-sm text-muted-foreground">暂无审计记录</div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
