'use client'

import { FormEvent, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
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
import { createFinanceOrder } from '@/lib/actions/finance'
import { formatCny } from '@/lib/finance'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { CurrencyCode, FinanceOrder, Profile } from '@/types'

export interface RegisterablePi {
  id: string
  pi_number: string
  customer_snapshot: {
    name?: string | null
    company?: string | null
  } | null
  total: number
  currency: CurrencyCode
}

export interface PerformanceManagerProps {
  profile: Pick<Profile, 'id' | 'role'>
  orders: FinanceOrder[]
  availablePis: RegisterablePi[]
}

function getCustomerName(pi: RegisterablePi) {
  return pi.customer_snapshot?.company || pi.customer_snapshot?.name || '未命名客户'
}

export function PerformanceManager({
  profile,
  orders,
  availablePis,
}: PerformanceManagerProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [selectedPiId, setSelectedPiId] = useState('')
  const [exchangeRate, setExchangeRate] = useState('')

  const selectedPi = useMemo(
    () => availablePis.find((pi) => pi.id === selectedPiId),
    [availablePis, selectedPiId],
  )
  const canRegister = profile.role === 'sales'

  function resetFormState() {
    setSelectedPiId('')
    setExchangeRate('')
  }

  function handlePiChange(piId: string) {
    const pi = availablePis.find((item) => item.id === piId)
    setSelectedPiId(piId)
    setExchangeRate(pi?.currency === 'CNY' ? '1' : '')
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canRegister || !selectedPi) return

    const form = event.currentTarget
    const formData = new FormData(form)
    startTransition(async () => {
      const result = await createFinanceOrder(formData)
      if (!result.ok) {
        toast.error(result.error ?? Object.values(result.fieldErrors ?? {})[0]?.[0] ?? '登记失败')
        return
      }

      toast.success('业绩登记成功')
      form.reset()
      resetFormState()
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      {canRegister && (
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            可登记 {availablePis.length} 张有效且尚未登记的 PI
          </p>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button disabled={availablePis.length === 0}>
                <Plus className="h-4 w-4" />
                登记业绩
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-xl">
              <DialogHeader>
                <DialogTitle>登记业绩</DialogTitle>
                <DialogDescription>
                  请选择自己名下尚未登记的有效 PI。订单金额、币种和客户信息将由服务端重新读取。
                </DialogDescription>
              </DialogHeader>
              <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="pi_id">PI</Label>
                  <Select
                    name="pi_id"
                    value={selectedPiId}
                    onValueChange={handlePiChange}
                    required
                  >
                    <SelectTrigger id="pi_id">
                      <SelectValue placeholder="请选择 PI" />
                    </SelectTrigger>
                    <SelectContent>
                      {availablePis.map((pi) => (
                        <SelectItem key={pi.id} value={pi.id}>
                          {pi.pi_number} · {getCustomerName(pi)} ·{' '}
                          {formatCurrency(Number(pi.total), pi.currency)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="order_date">业绩日期</Label>
                  <Input id="order_date" name="order_date" type="date" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="exchange_rate_to_cny">兑人民币汇率</Label>
                  <Input
                    id="exchange_rate_to_cny"
                    name="exchange_rate_to_cny"
                    type="number"
                    min="0.00000001"
                    max="1000000"
                    step="0.00000001"
                    value={selectedPi?.currency === 'CNY' ? '1' : exchangeRate}
                    onChange={(event) => setExchangeRate(event.target.value)}
                    placeholder={selectedPi ? `${selectedPi.currency} → CNY` : '请先选择 PI'}
                    readOnly={selectedPi?.currency === 'CNY'}
                    disabled={!selectedPi}
                    required
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="notes">备注（可选）</Label>
                  <Input id="notes" name="notes" maxLength={1000} placeholder="填写业绩相关备注" />
                </div>

                {selectedPi && (
                  <div className="rounded-md border bg-muted/40 p-3 text-sm sm:col-span-2">
                    <div className="font-medium">{selectedPi.pi_number}</div>
                    <div className="mt-1 text-muted-foreground">
                      {getCustomerName(selectedPi)} ·{' '}
                      {formatCurrency(Number(selectedPi.total), selectedPi.currency)}
                    </div>
                  </div>
                )}

                <DialogFooter className="sm:col-span-2">
                  <Button type="submit" disabled={pending || !selectedPi}>
                    {pending ? '登记中…' : '确认登记'}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      )}

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>业绩日期</TableHead>
              <TableHead>PI / 客户</TableHead>
              <TableHead>业务员</TableHead>
              <TableHead className="text-right">原币金额</TableHead>
              <TableHead className="text-right">兑人民币汇率</TableHead>
              <TableHead className="text-right">折合人民币</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>备注</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((order) => (
              <TableRow key={order.id}>
                <TableCell className="whitespace-nowrap">{formatDate(order.order_date)}</TableCell>
                <TableCell>
                  <div className="font-medium">{order.pi_number_snapshot}</div>
                  <div className="text-xs text-muted-foreground">
                    {order.customer_name_snapshot || '—'}
                  </div>
                </TableCell>
                <TableCell>{order.salesperson_name_snapshot || '—'}</TableCell>
                <TableCell className="whitespace-nowrap text-right">
                  {formatCurrency(Number(order.amount_original), order.currency)}
                </TableCell>
                <TableCell className="text-right">
                  {Number(order.exchange_rate_to_cny).toLocaleString('zh-CN', {
                    maximumFractionDigits: 8,
                  })}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right font-medium">
                  {formatCny(Number(order.amount_cny))}
                </TableCell>
                <TableCell>
                  <Badge variant={order.status === 'active' ? 'success' : 'secondary'}>
                    {order.status === 'active' ? '有效' : '作废'}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-64 text-muted-foreground">
                  <span className="line-clamp-2">{order.notes || '—'}</span>
                </TableCell>
              </TableRow>
            ))}
            {orders.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-12 text-center text-muted-foreground">
                  暂无业绩记录
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
