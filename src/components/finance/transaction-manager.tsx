'use client'

import { FormEvent, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Ban, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
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
import { createFinanceTransaction, voidFinanceTransaction } from '@/lib/actions/finance'
import { formatCny, FINANCE_TRANSACTION_LABELS } from '@/lib/finance'
import { formatCurrency, formatDate, displayProfileName } from '@/lib/utils'
import { financeCurrencies } from '@/schemas/finance'
import type { CurrencyCode, FinanceOrder, FinanceTransaction, Profile } from '@/types'

interface TransactionManagerProps {
  transactions: FinanceTransaction[]
  orders: Pick<FinanceOrder, 'id' | 'pi_number_snapshot'>[]
  salespeople: Pick<Profile, 'id' | 'full_name' | 'email' | 'chinese_name'>[]
}

export function TransactionManager({
  transactions,
  orders,
  salespeople,
}: TransactionManagerProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [currency, setCurrency] = useState<CurrencyCode>('CNY')
  const [exchangeRate, setExchangeRate] = useState('1')

  function handleCurrencyChange(value: CurrencyCode) {
    setCurrency(value)
    setExchangeRate(value === 'CNY' ? '1' : '')
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    startTransition(async () => {
      const result = await createFinanceTransaction(formData)
      if (!result.ok) {
        toast.error(result.error ?? Object.values(result.fieldErrors ?? {})[0]?.[0] ?? '保存失败')
        return
      }
      toast.success('收支记录已保存')
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
      const result = await voidFinanceTransaction(id, reason)
      if (!result.ok) toast.error(result.error ?? '作废失败')
      else {
        toast.success('收支记录已作废')
        router.refresh()
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4" />
              录入收支
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>录入其他收支</DialogTitle>
              <DialogDescription>业务订单客户收款请在订单详情登记；此处仅录入其他独立收支。</DialogDescription>
            </DialogHeader>
            <form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <Label htmlFor="transaction_type">类型</Label>
                <Select name="transaction_type" defaultValue="income">
                  <SelectTrigger id="transaction_type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="income">收入</SelectItem>
                    <SelectItem value="expense">支出</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="category">分类</Label>
                <Input id="category" name="category" placeholder="例如：利息收入、办公费用" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="transaction_date">日期</Label>
                <Input id="transaction_date" name="transaction_date" type="date" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="amount_original">原币金额</Label>
                <Input id="amount_original" name="amount_original" type="number" min="0.01" step="0.01" required />
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
                  max="1000000"
                  step="0.00000001"
                  value={exchangeRate}
                  onChange={(event) => setExchangeRate(event.target.value)}
                  readOnly={currency === 'CNY'}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="finance_order_id">关联订单（可选）</Label>
                <Select name="finance_order_id">
                  <SelectTrigger id="finance_order_id"><SelectValue placeholder="不关联订单" /></SelectTrigger>
                  <SelectContent>
                    {orders.map((order) => (
                      <SelectItem key={order.id} value={order.id}>{order.pi_number_snapshot}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="salesperson_id">业务员（可选）</Label>
                <Select name="salesperson_id">
                  <SelectTrigger id="salesperson_id"><SelectValue placeholder="不指定" /></SelectTrigger>
                  <SelectContent>
                    {salespeople.map((person) => (
                      <SelectItem key={person.id} value={person.id}>
                        {displayProfileName(person)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reference_no">凭证号（可选）</Label>
                <Input id="reference_no" name="reference_no" />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="description">备注</Label>
                <Input id="description" name="description" />
              </div>
              <DialogFooter className="sm:col-span-2">
                <Button type="submit" disabled={pending}>{pending ? '保存中…' : '保存'}</Button>
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
              <TableHead>类型</TableHead>
              <TableHead>分类/凭证</TableHead>
              <TableHead>业务员</TableHead>
              <TableHead className="text-right">原币金额</TableHead>
              <TableHead className="text-right">折合人民币</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{formatDate(row.transaction_date)}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant={row.transaction_type === 'income' ? 'success' : 'secondary'}>
                      {FINANCE_TRANSACTION_LABELS[row.transaction_type]}
                    </Badge>
                    {row.status === 'void' && <Badge variant="outline">已作废</Badge>}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{row.category}</div>
                  <div className="text-xs text-muted-foreground">
                    {row.status === 'void' ? row.void_reason || '已作废' : row.reference_no || row.description || '—'}
                  </div>
                </TableCell>
                <TableCell>
                  {displayProfileName(
                    row.salesperson,
                    row.salesperson_display_name_snapshot?.trim() || row.salesperson_name_snapshot,
                  )}
                </TableCell>
                <TableCell className="text-right">{formatCurrency(Number(row.amount_original), row.currency)}</TableCell>
                <TableCell className="text-right font-medium">{formatCny(Number(row.amount_cny))}</TableCell>
                <TableCell>
                  {row.status === 'active' && (
                    <Button variant="ghost" size="icon" disabled={pending} onClick={() => handleVoid(row.id)} aria-label="作废收支记录">
                      <Ban className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {transactions.length === 0 && (
              <TableRow><TableCell colSpan={7} className="py-12 text-center text-muted-foreground">暂无收支记录</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
