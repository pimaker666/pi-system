'use client'

import { FormEvent, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Ban, Plus } from 'lucide-react'
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
  DialogTrigger,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { createFinanceCost, voidFinanceCost } from '@/lib/actions/finance'
import { FINANCE_COST_LABELS, formatCny } from '@/lib/finance'
import { formatCurrency, formatDate } from '@/lib/utils'
import { financeCostTypes, financeCurrencies } from '@/schemas/finance'
import type { CurrencyCode, FinanceOrderCost } from '@/types'

export interface CostOrderOption {
  id: string
  source: 'finance' | 'business'
  reference: string
  customer: string | null
}

export interface PiCostManagerProps {
  orders: CostOrderOption[]
  costs: FinanceOrderCost[]
}

function formatExchangeRate(rate: number) {
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  }).format(rate)
}

export function PiCostManager({ orders, costs }: PiCostManagerProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [currency, setCurrency] = useState<CurrencyCode>('CNY')
  const [exchangeRate, setExchangeRate] = useState('1')
  const ordersByReference = new Map(
    orders.map((order) => [`${order.source}:${order.id}`, order]),
  )

  function handleCurrencyChange(value: CurrencyCode) {
    setCurrency(value)
    setExchangeRate(value === 'CNY' ? '1' : '')
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)

    startTransition(async () => {
      const result = await createFinanceCost(formData)
      if (!result.ok) {
        toast.error(result.error ?? Object.values(result.fieldErrors ?? {})[0]?.[0] ?? '保存失败')
        return
      }

      toast.success('订单成本已保存')
      form.reset()
      setCurrency('CNY')
      setExchangeRate('1')
      setOpen(false)
      router.refresh()
    })
  }

  function handleVoid(id: string) {
    const reason = window.prompt('请输入作废原因（原记录和金额会保留）：')
    if (reason === null) return
    if (!reason.trim()) {
      toast.error('请填写作废原因')
      return
    }

    startTransition(async () => {
      const result = await voidFinanceCost(id, reason)
      if (!result.ok) {
        toast.error(result.error ?? '作废失败')
        return
      }

      toast.success('订单成本已作废')
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {orders.length === 0 ? '暂无可归集成本的订单。' : '成本可归集到历史 PI 或已审核业务订单。'}
        </p>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button disabled={orders.length === 0 || pending}>
              <Plus className="h-4 w-4" />
              录入成本
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>录入订单成本</DialogTitle>
              <DialogDescription>选择已登记订单，保存原币金额和当日汇率。</DialogDescription>
            </DialogHeader>
            <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="order_reference">订单</Label>
                <Select name="order_reference" required>
                  <SelectTrigger id="order_reference">
                    <SelectValue placeholder="请选择订单" />
                  </SelectTrigger>
                  <SelectContent>
                    {orders.map((order) => (
                      <SelectItem
                        key={`${order.source}:${order.id}`}
                        value={`${order.source}:${order.id}`}
                      >
                        {order.source === 'business' ? '业务订单' : '历史 PI'} · {order.reference}
                        {order.customer ? ` · ${order.customer}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cost_type">成本类型</Label>
                <Select name="cost_type" defaultValue="product">
                  <SelectTrigger id="cost_type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {financeCostTypes.map((type) => (
                      <SelectItem key={type} value={type}>
                        {FINANCE_COST_LABELS[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="incurred_date">发生日期</Label>
                <Input id="incurred_date" name="incurred_date" type="date" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="amount_original">原币金额</Label>
                <Input
                  id="amount_original"
                  name="amount_original"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="currency">币种</Label>
                <Select
                  name="currency"
                  value={currency}
                  onValueChange={(value) => handleCurrencyChange(value as CurrencyCode)}
                >
                  <SelectTrigger id="currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {financeCurrencies.map((code) => (
                      <SelectItem key={code} value={code}>
                        {code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="exchange_rate_to_cny">兑人民币汇率</Label>
                <Input
                  id="exchange_rate_to_cny"
                  name="exchange_rate_to_cny"
                  type="number"
                  min="0.00000001"
                  step="0.00000001"
                  value={exchangeRate}
                  onChange={(event) => setExchangeRate(event.target.value)}
                  readOnly={currency === 'CNY'}
                  required
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="description">备注</Label>
                <Input id="description" name="description" maxLength={1000} />
              </div>
              <DialogFooter className="sm:col-span-2">
                <Button type="submit" disabled={pending}>
                  {pending ? '保存中…' : '保存'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>日期</TableHead>
              <TableHead>订单</TableHead>
              <TableHead>成本类型/备注</TableHead>
              <TableHead className="text-right">原币金额</TableHead>
              <TableHead className="text-right">兑人民币汇率</TableHead>
              <TableHead className="text-right">折合人民币</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {costs.map((cost) => {
              const orderReference = cost.business_order_id
                ? `business:${cost.business_order_id}`
                : `finance:${cost.finance_order_id}`
              const order = ordersByReference.get(orderReference)
              return (
                <TableRow key={cost.id}>
                  <TableCell>{formatDate(cost.incurred_date)}</TableCell>
                  <TableCell>
                    <div className="font-medium">{order?.reference ?? '订单已不可用'}</div>
                    <div className="text-xs text-muted-foreground">
                      {order?.customer || '—'}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="font-medium">{FINANCE_COST_LABELS[cost.cost_type]}</span>
                      {cost.status === 'void' && <Badge variant="outline">已作废</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {cost.status === 'void' ? cost.void_reason || '已作废' : cost.description || '—'}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(Number(cost.amount_original), cost.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatExchangeRate(Number(cost.exchange_rate_to_cny))}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatCny(Number(cost.amount_cny))}
                  </TableCell>
                  <TableCell>
                    {cost.status === 'active' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={pending}
                        onClick={() => handleVoid(cost.id)}
                        aria-label="作废订单成本"
                      >
                        <Ban className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
            {costs.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                  暂无订单成本记录
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
