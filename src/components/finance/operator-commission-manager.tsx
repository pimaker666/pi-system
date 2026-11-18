'use client'

import Link from 'next/link'
import { useMemo, useState, useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { CheckCircle2, Plus, RotateCcw, Save, Settings2, Trash2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import {
  confirmOperatorCommissionClearance,
  rejectOperatorCommissionClearance,
  resetOperatorCommissionClearance,
  saveOrderOperatorAssignments,
  saveShopOperatorRules,
  submitOperatorCommissionClearance,
} from '@/lib/actions/operator-commission'
import type { BusinessOrderCommissionFilters } from '@/lib/business-order-commission'
import { formatCommissionAmount } from '@/lib/business-order-commission'
import { chinaCurrentMonth } from '@/lib/china-date'
import { OPERATOR_COMMISSION_PAGE_SIZE, type OperatorRuleInput } from '@/lib/operator-commission'
import type { OperatorCandidate, ShopOperatorRuleWithName } from '@/lib/operator-commission-server'
import type {
  CommissionRule,
  CurrencyCode,
  OperatorCommissionRow,
  OperatorCommissionSummaryTotal,
  OperatorRateMode,
  UserRole,
} from '@/types'
import { CommissionRuleSettings } from '@/components/finance/commission-rule-settings'
import { formatDailyMoney } from '@/lib/daily-orders'
import { cn } from '@/lib/utils'

interface RuleDraft {
  operator_id: string
  share_percent: string
  product_commission_rate: string
  rate_mode: OperatorRateMode
}

function toDraft(rules: OperatorRuleInput[]): RuleDraft[] {
  return rules.map((rule) => ({
    operator_id: rule.operator_id,
    share_percent: String(rule.share_percent),
    product_commission_rate: String(rule.product_commission_rate),
    rate_mode: rule.rate_mode,
  }))
}

function parseDrafts(drafts: RuleDraft[]): { rules: OperatorRuleInput[] } | { error: string } {
  const rules: OperatorRuleInput[] = []
  const seen = new Set<string>()
  for (const draft of drafts) {
    if (!draft.operator_id) return { error: '请选择运营人员' }
    if (seen.has(draft.operator_id)) return { error: '同一运营人员重复配置' }
    seen.add(draft.operator_id)
    const share = Number(draft.share_percent)
    const rate = Number(draft.product_commission_rate)
    if (!Number.isFinite(share) || share <= 0 || share > 100) return { error: '份额须在 0-100 之间' }
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return { error: '提点须在 0-100 之间' }
    rules.push({
      operator_id: draft.operator_id,
      share_percent: share,
      product_commission_rate: rate,
      rate_mode: draft.rate_mode,
    })
  }
  return { rules }
}

const STATUS_LABELS: Record<string, string> = {
  pending: '待确认',
  confirmed: '已结清',
  rejected: '已驳回',
}

function statusBadgeClass(status: string | null) {
  if (status === 'confirmed') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (status === 'pending') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (status === 'rejected') return 'border-rose-200 bg-rose-50 text-rose-700'
  return 'border-muted bg-muted text-muted-foreground'
}

function money(value: number, currency: CurrencyCode) {
  return formatDailyMoney(value, currency)
}

function RateModeSelect({
  value,
  onChange,
}: {
  value: OperatorRateMode
  onChange: (value: OperatorRateMode) => void
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as OperatorRateMode)}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="fixed">固定点数</SelectItem>
        <SelectItem value="rules">按规则</SelectItem>
      </SelectContent>
    </Select>
  )
}

interface OperatorCommissionManagerProps {
  rows: OperatorCommissionRow[]
  totalCount: number
  filters: BusinessOrderCommissionFilters
  summary?: OperatorCommissionSummaryTotal[]
  shopRules: ShopOperatorRuleWithName[]
  operators: OperatorCandidate[]
  shops: Array<{ id: string; name: string }>
  commissionRules?: CommissionRule[]
  tagOptions?: Array<{ color: string; label: string }>
  actorRole: UserRole
  actorId: string
  canManageRules: boolean
  canManageClearance: boolean
  /** 运营本人可在「我的提成」确认/驳回自己的待确认记录。 */
  canConfirmSelf?: boolean
  readOnly?: boolean
  showSummary?: boolean
  showFilters?: boolean
}

export function OperatorCommissionManager({
  rows,
  totalCount,
  filters,
  summary,
  shopRules,
  operators,
  shops,
  commissionRules = [],
  tagOptions = [],
  actorRole,
  actorId,
  canManageRules,
  canManageClearance,
  canConfirmSelf = false,
  readOnly = false,
  showSummary = false,
  showFilters = true,
}: OperatorCommissionManagerProps) {
  const router = useRouter()
  const pathname = usePathname()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, startTransition] = useTransition()
  const [period, setPeriod] = useState(chinaCurrentMonth)
  const [submitDialogOpen, setSubmitDialogOpen] = useState(false)
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [withdrawDialogOpen, setWithdrawDialogOpen] = useState(false)
  const [rulesDialogOpen, setRulesDialogOpen] = useState(false)
  const [rulesShopId, setRulesShopId] = useState(shops[0]?.id ?? '')
  const [rulesRows, setRulesRows] = useState<RuleDraft[]>([])
  const [assignmentTarget, setAssignmentTarget] = useState<OperatorCommissionRow | null>(null)
  const [assignmentRows, setAssignmentRows] = useState<RuleDraft[]>([])

  const keyOf = (row: OperatorCommissionRow) => `${row.order_id}\u0000${row.operator_id}`
  const selectedRows = useMemo(
    () => rows.filter((row) => selected.has(keyOf(row))),
    [rows, selected],
  )
  const selectedItems = selectedRows.map((row) => ({
    business_order_id: row.order_id,
    operator_id: row.operator_id,
  }))

  const canAssignOrders =
    !readOnly && (canManageClearance || actorRole === 'sales' || actorRole === 'supervisor')

  const totalPages = Math.max(1, Math.ceil(totalCount / OPERATOR_COMMISSION_PAGE_SIZE))

  function toggleRow(row: OperatorCommissionRow) {
    const key = keyOf(row)
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function pageHref(page: number) {
    const params = new URLSearchParams()
    if (filters.q) params.set('q', filters.q)
    if (filters.month) params.set('month', filters.month)
    filters.shops.forEach((id) => params.append('shops', id))
    if (pathname.startsWith('/finance/commission')) params.set('view', 'operator')
    if (page > 1) params.set('page', String(page))
    const query = params.toString()
    return query ? `${pathname}?${query}` : pathname
  }

  function openRulesDialog() {
    const shopId = rulesShopId || shops[0]?.id || ''
    setRulesShopId(shopId)
    setRulesRows(
      toDraft(
        shopRules
          .filter((rule) => rule.shop_id === shopId)
          .map((rule) => ({
            operator_id: rule.operator_id,
            share_percent: Number(rule.share_percent),
            product_commission_rate: Number(rule.product_commission_rate),
            rate_mode: rule.rate_mode,
          })),
      ),
    )
    setRulesDialogOpen(true)
  }

  function changeRulesShop(shopId: string) {
    setRulesShopId(shopId)
    setRulesRows(
      toDraft(
        shopRules
          .filter((rule) => rule.shop_id === shopId)
          .map((rule) => ({
            operator_id: rule.operator_id,
            share_percent: Number(rule.share_percent),
            product_commission_rate: Number(rule.product_commission_rate),
            rate_mode: rule.rate_mode,
          })),
      ),
    )
  }

  function saveRules() {
    const parsed = parseDrafts(rulesRows)
    if ('error' in parsed) {
      toast.error(parsed.error)
      return
    }
    startTransition(async () => {
      const result = await saveShopOperatorRules({ shop_id: rulesShopId, rules: parsed.rules })
      if (!result.ok) {
        toast.error(result.error ?? '保存失败')
        return
      }
      toast.success('店铺运营规则已保存')
      setRulesDialogOpen(false)
      router.refresh()
    })
  }

  function openAssignmentDialog(row: OperatorCommissionRow) {
    const current = rows
      .filter((item) => item.order_id === row.order_id && item.has_assignment)
      .map((item) => ({
        operator_id: item.operator_id,
        share_percent: item.share_percent,
        product_commission_rate: item.product_commission_rate,
        rate_mode: item.rate_mode,
      }))
    setAssignmentTarget(row)
    setAssignmentRows(toDraft(current))
  }

  function saveAssignment(clear: boolean) {
    if (!assignmentTarget) return
    const rules = clear ? [] : parseDrafts(assignmentRows)
    if (!clear && 'error' in rules) {
      toast.error(rules.error)
      return
    }
    startTransition(async () => {
      const result = await saveOrderOperatorAssignments({
        business_order_id: assignmentTarget.order_id,
        rules: clear ? [] : (rules as { rules: OperatorRuleInput[] }).rules,
      })
      if (!result.ok) {
        toast.error(result.error ?? '保存失败')
        return
      }
      toast.success(clear ? '已清除订单指定，恢复店铺规则' : '订单运营已指定')
      setAssignmentTarget(null)
      setSelected(new Set())
      router.refresh()
    })
  }

  function submitClearance(direct: boolean) {
    if (selectedItems.length === 0) return
    startTransition(async () => {
      const result = await submitOperatorCommissionClearance({
        items: selectedItems,
        period,
        direct,
      })
      if (!result.ok) {
        toast.error(result.error ?? '提交失败')
        return
      }
      toast.success(direct ? '已直接结清运营提成' : '已提交运营提成结清，等待运营确认')
      setSubmitDialogOpen(false)
      setSelected(new Set())
      router.refresh()
    })
  }

  function withdrawSelected() {
    if (selectedItems.length === 0) return
    startTransition(async () => {
      const result = await resetOperatorCommissionClearance({ items: selectedItems })
      if (!result.ok) {
        toast.error(result.error ?? '撤回失败')
        return
      }
      toast.success('已撤回所选运营提成结清')
      setWithdrawDialogOpen(false)
      setSelected(new Set())
      router.refresh()
    })
  }

  function confirmSelected() {
    if (selectedItems.length === 0) return
    startTransition(async () => {
      const result = await confirmOperatorCommissionClearance({ items: selectedItems })
      if (!result.ok) {
        toast.error(result.error ?? '确认失败')
        return
      }
      toast.success('运营提成已确认结清')
      setSelected(new Set())
      router.refresh()
    })
  }

  function rejectSelected() {
    if (selectedItems.length === 0) return
    startTransition(async () => {
      const result = await rejectOperatorCommissionClearance({
        items: selectedItems,
        reason: rejectReason,
      })
      if (!result.ok) {
        toast.error(result.error ?? '驳回失败')
        return
      }
      toast.success('已驳回所选运营提成')
      setRejectDialogOpen(false)
      setRejectReason('')
      setSelected(new Set())
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      {showSummary && summary && (
        <section className="space-y-3 rounded-xl border bg-card p-4 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
          <div>
            <h2 className="font-semibold">已结清运营提成总览</h2>
            <p className="text-sm text-muted-foreground">按运营人 + 结清归属月统计，美元按结清时锁定的汇率折算。</p>
          </div>
          {summary.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">暂无已结清运营提成</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="border-b text-left text-muted-foreground">
                  <tr>
                    {actorRole !== 'operations' && <th className="px-3 py-2 font-medium">运营</th>}
                    <th className="px-3 py-2 font-medium">结清月份</th>
                    <th className="px-3 py-2 text-right font-medium">运营提成</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((total) => (
                    <tr key={`${total.operatorName}-${total.period}`} className="border-b last:border-0">
                      {actorRole !== 'operations' && <td className="px-3 py-2">{total.operatorName}</td>}
                      <td className="px-3 py-2 tabular-nums">{total.period}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {formatCommissionAmount(total.amount)}
                        {total.missingRateCount > 0 && (
                          <span className="ml-2 text-xs font-normal text-amber-600">
                            {total.missingRateCount} 条美元订单未计入
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {!readOnly && (canManageClearance || canManageRules) && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
          {canManageClearance && (
            <>
              <Button
                type="button"
                disabled={selectedItems.length === 0}
                onClick={() => setSubmitDialogOpen(true)}
              >
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                提交结清（{selectedItems.length}）
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={selectedItems.length === 0}
                onClick={() => setWithdrawDialogOpen(true)}
              >
                <RotateCcw className="mr-1.5 h-4 w-4" />
                撤回结清
              </Button>
            </>
          )}
          {canConfirmSelf && !canManageClearance && (
            <>
              <Button type="button" disabled={selectedItems.length === 0} onClick={confirmSelected}>
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                确认结清（{selectedItems.length}）
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={selectedItems.length === 0}
                onClick={() => setRejectDialogOpen(true)}
              >
                <XCircle className="mr-1.5 h-4 w-4" />
                驳回
              </Button>
            </>
          )}
          {canManageRules && (
            <Button type="button" variant="outline" onClick={openRulesDialog}>
              <Settings2 className="mr-1.5 h-4 w-4" />
              店铺运营规则
            </Button>
          )}
          {canManageRules && (
            <CommissionRuleSettings line="operator" rules={commissionRules} tagOptions={tagOptions} />
          )}
          <span className="text-xs text-muted-foreground">
            运营提成 = 产品实收 × 提点% × 本人份额%；订单指定运营后不再叠加店铺规则。
          </span>
        </div>
      )}

      {showFilters && (
        <form className="rounded-xl border bg-card shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <h2 className="text-sm font-semibold">筛选运营提成</h2>
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
              共 {totalCount} 条
            </span>
          </div>
          <div className="grid gap-3 p-4 md:grid-cols-4">
            <input type="hidden" name="page" value="1" />
            {pathname.startsWith('/finance/commission') && <input type="hidden" name="view" value="operator" />}
            <Input name="q" defaultValue={filters.q} placeholder="订单号/平台单号/产品/SKU" />
            <Input type="month" name="month" defaultValue={filters.month ?? ''} />
            <Select name="shops" defaultValue={filters.shops[0] ?? '__all__'}>
              <SelectTrigger>
                <SelectValue placeholder="全部店铺" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部店铺</SelectItem>
                {shops.map((shop) => (
                  <SelectItem key={shop.id} value={shop.id}>
                    {shop.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Button type="submit">筛选</Button>
              <Button asChild type="button" variant="outline">
                <Link href={pageHref(1)}>清空</Link>
              </Button>
            </div>
          </div>
        </form>
      )}

      <div className="overflow-x-auto rounded-md border">
        <Table className="w-full min-w-[1180px] text-sm">
          <TableHeader>
            <TableRow className="bg-background">
              {!readOnly && <TableHead className="w-9"></TableHead>}
              <TableHead>订单日期</TableHead>
              <TableHead>订单号</TableHead>
              <TableHead>店铺</TableHead>
              <TableHead>客户</TableHead>
              <TableHead>业务员</TableHead>
              <TableHead>运营</TableHead>
              <TableHead className="text-right">份额</TableHead>
              <TableHead className="text-right">产品实收金额</TableHead>
              <TableHead className="text-right">运营提点</TableHead>
              <TableHead className="text-right">运营提成</TableHead>
              <TableHead>结清状态</TableHead>
              {canAssignOrders && <TableHead className="w-24">操作</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={12}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  当前筛选下没有运营提成记录，请先配置店铺运营规则或在订单上指定运营。
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const key = keyOf(row)
                const isSelf = row.operator_id === actorId
                return (
                  <TableRow key={key} className={cn(isSelf && 'bg-primary/[0.03]')}>
                    {!readOnly && (
                      <TableCell>
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-gray-300"
                          checked={selected.has(key)}
                          onChange={() => toggleRow(row)}
                        />
                      </TableCell>
                    )}
                    <TableCell className="whitespace-nowrap tabular-nums">{row.order_date}</TableCell>
                    <TableCell className="whitespace-nowrap">{row.order_number || '—'}</TableCell>
                    <TableCell className="max-w-36 truncate">{row.shop_name || '—'}</TableCell>
                    <TableCell className="max-w-36 truncate">{row.customer_name || '—'}</TableCell>
                    <TableCell className="max-w-32 truncate">{row.salesperson_name}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {row.operator_name}
                      {row.has_assignment ? (
                        <Badge variant="outline" className="ml-1.5 border-sky-200 bg-sky-50 text-[10px] text-sky-700">
                          订单指定
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.share_percent}%</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(row.product_received_amount, row.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.product_commission_rate}%
                      {row.rate_mode === 'rules' && (
                        <div className="text-[10px] font-normal text-muted-foreground">
                          {row.commission_rule_name ?? '规则未命中（0%）'}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {money(row.commission_amount, row.currency)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant="outline" className={statusBadgeClass(row.clearance_status)}>
                        {row.clearance_status ? STATUS_LABELS[row.clearance_status] : '未结清'}
                      </Badge>
                      {row.clearance_period && (
                        <span className="ml-1.5 text-xs text-muted-foreground">{row.clearance_period}</span>
                      )}
                    </TableCell>
                    {canAssignOrders && (
                      <TableCell>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => openAssignmentDialog(row)}
                        >
                          指定运营
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button asChild variant="outline" size="sm" disabled={filters.page <= 1}>
            <Link href={pageHref(Math.max(1, filters.page - 1))}>上一页</Link>
          </Button>
          <span className="tabular-nums text-muted-foreground">
            {filters.page} / {totalPages}
          </span>
          <Button asChild variant="outline" size="sm" disabled={filters.page >= totalPages}>
            <Link href={pageHref(Math.min(totalPages, filters.page + 1))}>下一页</Link>
          </Button>
        </div>
      )}

      <Dialog open={submitDialogOpen} onOpenChange={setSubmitDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>提交运营提成结清</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              已选 {selectedItems.length} 条运营提成记录。提交后运营在「我的提成」确认；直接结清会立即锁定金额。
            </p>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">结清归属月</span>
              <Input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSubmitDialogOpen(false)}>
              取消
            </Button>
            <Button type="button" disabled={pending} onClick={() => submitClearance(false)}>
              提交待确认
            </Button>
            <Button type="button" disabled={pending} onClick={() => submitClearance(true)}>
              直接结清
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>驳回运营提成结清</DialogTitle>
          </DialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
            placeholder="请填写驳回原因（会展示给财务）"
            rows={4}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRejectDialogOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending || rejectReason.trim().length === 0}
              onClick={rejectSelected}
            >
              确认驳回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={withdrawDialogOpen} onOpenChange={setWithdrawDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>撤回所选运营提成结清？</AlertDialogTitle>
            <AlertDialogDescription>
              撤回后这些记录会回到未结清状态，已确认结清的记录不会被撤回。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={withdrawSelected}>确认撤回</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={rulesDialogOpen} onOpenChange={setRulesDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>店铺运营规则</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Select value={rulesShopId} onValueChange={changeRulesShop}>
              <SelectTrigger>
                <SelectValue placeholder="选择店铺" />
              </SelectTrigger>
              <SelectContent>
                {shops.map((shop) => (
                  <SelectItem key={shop.id} value={shop.id}>
                    {shop.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              份额按人独立：多人可以合计 100% 分摊，也可以每人 100% 各自拿全额。订单级指定优先于店铺规则。提点可选固定点数，或选「按规则」由运营提成规则按条件自动取点。
            </p>
            <div className="space-y-2">
              {rulesRows.map((rule, index) => (
                <div key={index} className="grid grid-cols-[1fr_88px_88px_104px_36px] items-center gap-2">
                  <Select
                    value={rule.operator_id}
                    onValueChange={(value) =>
                      setRulesRows((current) =>
                        current.map((item, i) => (i === index ? { ...item, operator_id: value } : item)),
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="选择运营" />
                    </SelectTrigger>
                    <SelectContent>
                      {operators.map((operator) => (
                        <SelectItem key={operator.id} value={operator.id}>
                          {operator.name}
                          {operator.role === 'admin' ? '（管理员）' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    value={rule.share_percent}
                    onChange={(event) =>
                      setRulesRows((current) =>
                        current.map((item, i) =>
                          i === index ? { ...item, share_percent: event.target.value } : item,
                        ),
                      )
                    }
                    placeholder="份额%"
                  />
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    disabled={rule.rate_mode === 'rules'}
                    value={rule.rate_mode === 'rules' ? '' : rule.product_commission_rate}
                    onChange={(event) =>
                      setRulesRows((current) =>
                        current.map((item, i) =>
                          i === index ? { ...item, product_commission_rate: event.target.value } : item,
                        ),
                      )
                    }
                    placeholder={rule.rate_mode === 'rules' ? '按规则' : '提点%'}
                  />
                  <RateModeSelect
                    value={rule.rate_mode}
                    onChange={(value) =>
                      setRulesRows((current) =>
                        current.map((item, i) => (i === index ? { ...item, rate_mode: value } : item)),
                      )
                    }
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => setRulesRows((current) => current.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setRulesRows((current) => [
                  ...current,
                  { operator_id: '', share_percent: '100', product_commission_rate: '0', rate_mode: 'fixed' },
                ])
              }
            >
              <Plus className="mr-1.5 h-4 w-4" />
              添加运营
            </Button>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRulesDialogOpen(false)}>
              取消
            </Button>
            <Button type="button" disabled={pending || !rulesShopId} onClick={saveRules}>
              <Save className="mr-1.5 h-4 w-4" />
              保存规则
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={assignmentTarget !== null} onOpenChange={(open) => !open && setAssignmentTarget(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>指定订单运营 · {assignmentTarget?.order_number || '订单'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              指定后本单不再使用店铺规则（指定即替代）。清空并保存即可恢复店铺规则。提点选「按规则」时由运营提成规则自动取点。
            </p>
            <div className="space-y-2">
              {assignmentRows.map((rule, index) => (
                <div key={index} className="grid grid-cols-[1fr_88px_88px_104px_36px] items-center gap-2">
                  <Select
                    value={rule.operator_id}
                    onValueChange={(value) =>
                      setAssignmentRows((current) =>
                        current.map((item, i) => (i === index ? { ...item, operator_id: value } : item)),
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="选择运营" />
                    </SelectTrigger>
                    <SelectContent>
                      {operators.map((operator) => (
                        <SelectItem key={operator.id} value={operator.id}>
                          {operator.name}
                          {operator.role === 'admin' ? '（管理员）' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    value={rule.share_percent}
                    onChange={(event) =>
                      setAssignmentRows((current) =>
                        current.map((item, i) =>
                          i === index ? { ...item, share_percent: event.target.value } : item,
                        ),
                      )
                    }
                    placeholder="份额%"
                  />
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    disabled={rule.rate_mode === 'rules'}
                    value={rule.rate_mode === 'rules' ? '' : rule.product_commission_rate}
                    onChange={(event) =>
                      setAssignmentRows((current) =>
                        current.map((item, i) =>
                          i === index ? { ...item, product_commission_rate: event.target.value } : item,
                        ),
                      )
                    }
                    placeholder={rule.rate_mode === 'rules' ? '按规则' : '提点%'}
                  />
                  <RateModeSelect
                    value={rule.rate_mode}
                    onChange={(value) =>
                      setAssignmentRows((current) =>
                        current.map((item, i) => (i === index ? { ...item, rate_mode: value } : item)),
                      )
                    }
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => setAssignmentRows((current) => current.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {assignmentRows.length === 0 && (
                <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                  当前未指定运营，按店铺规则计算。
                </p>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setAssignmentRows((current) => [
                  ...current,
                  {
                    operator_id: '',
                    share_percent: '100',
                    product_commission_rate: String(assignmentTarget?.product_commission_rate ?? 0),
                    rate_mode: 'fixed',
                  },
                ])
              }
            >
              <Plus className="mr-1.5 h-4 w-4" />
              添加运营
            </Button>
            {assignmentTarget?.shop_name && (
              <p className="text-xs text-muted-foreground">所属店铺：{assignmentTarget.shop_name}</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAssignmentTarget(null)}>
              取消
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => saveAssignment(true)}
            >
              清除指定（用店铺规则）
            </Button>
            <Button type="button" disabled={pending} onClick={() => saveAssignment(false)}>
              <Save className="mr-1.5 h-4 w-4" />
              保存指定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
