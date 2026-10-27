'use client'

import { FormEvent, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { BarChart3, Download, FileUp, Pencil, Plus, Settings2, Tags, Trash2, Ban } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { DateRangePicker } from '@/components/shared/date-range-picker'
import {
  deleteJournalAccount,
  deleteJournalCategory,
  deleteJournalImportRule,
  importJournalEntries,
  previewJournalImport,
  saveJournalAccount,
  saveJournalCategory,
  saveJournalEntry,
  saveJournalImportRule,
  voidJournalEntry,
} from '@/lib/actions/finance'
import { formatCny, FINANCE_TRANSACTION_LABELS } from '@/lib/finance'
import { parseBocStatementText, parseCmbCsv, type JournalImportParsedRow } from '@/lib/journal-import'
import { cn, formatCurrency, formatDate, displayProfileName } from '@/lib/utils'
import { financeCurrencies } from '@/schemas/finance'
import type {
  CurrencyCode,
  FinanceJournalAccount,
  FinanceJournalAccountBalance,
  FinanceJournalCategory,
  FinanceJournalEntry,
  FinanceJournalImportRule,
  FinanceTransactionType,
  Profile,
} from '@/types'

interface JournalManagerProps {
  entries: FinanceJournalEntry[]
  accounts: FinanceJournalAccount[]
  categories: FinanceJournalCategory[]
  balances: FinanceJournalAccountBalance[]
  monthFlows: { account_id: string; income: number; expense: number }[]
  rules: FinanceJournalImportRule[]
  runningBalances: Record<string, number>
  members: Array<Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'>>
}

interface ImportPreviewRow extends JournalImportParsedRow {
  category_id: string | null
  shop: string | null
  reimbursee: string | null
  duplicate: boolean
  checked: boolean
}

function todayString() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

function toastError(result: { error?: string; fieldErrors?: Record<string, string[] | undefined> }) {
  toast.error(result.error ?? Object.values(result.fieldErrors ?? {})[0]?.[0] ?? '操作失败')
}

export function JournalManager({
  entries,
  accounts,
  categories,
  balances,
  monthFlows,
  rules,
  runningBalances,
  members,
}: JournalManagerProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [dateRange, setDateRange] = useState({ from: '', to: '' })
  const [accountFilter, setAccountFilter] = useState('all')
  const [kindFilter, setKindFilter] = useState<'all' | FinanceTransactionType>('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'normal' | 'voided'>('all')
  const [shopFilter, setShopFilter] = useState('all')
  const [keyword, setKeyword] = useState('')

  // 月度汇总
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [summaryAccount, setSummaryAccount] = useState('all')

  // 记一笔 / 编辑分录
  const [entryDialogOpen, setEntryDialogOpen] = useState(false)
  const [editingEntry, setEditingEntry] = useState<FinanceJournalEntry | null>(null)
  const [entryAccount, setEntryAccount] = useState('')
  const [entryKind, setEntryKind] = useState<FinanceTransactionType>('expense')
  const [entryCategory, setEntryCategory] = useState('')
  const [entryCurrency, setEntryCurrency] = useState<CurrencyCode>('CNY')
  const [entryRate, setEntryRate] = useState('1')

  // 作废
  const [voidTarget, setVoidTarget] = useState<FinanceJournalEntry | null>(null)
  const [voidReason, setVoidReason] = useState('')

  // 账户管理
  const [accountDialogOpen, setAccountDialogOpen] = useState(false)
  const [editingAccount, setEditingAccount] = useState<FinanceJournalAccount | null>(null)

  // 分类管理
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false)
  const [editingCategory, setEditingCategory] = useState<FinanceJournalCategory | null>(null)

  // 流水导入
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importTab, setImportTab] = useState<'csv' | 'text'>('csv')
  const [importAccount, setImportAccount] = useState('')
  const [importRate, setImportRate] = useState('1')
  const [importText, setImportText] = useState('')
  const [importFileName, setImportFileName] = useState('')
  const [previewRows, setPreviewRows] = useState<ImportPreviewRow[] | null>(null)
  const importFileRef = useRef<HTMLInputElement>(null)

  const activeAccounts = useMemo(() => accounts.filter((a) => a.is_active), [accounts])
  const kindCategories = useMemo(
    () => categories.filter((c) => c.kind === entryKind && c.is_active),
    [categories, entryKind],
  )

  const shopOptions = useMemo(
    () => [...new Set(entries.map((row) => row.shop).filter((shop): shop is string => Boolean(shop)))].sort(),
    [entries],
  )

  const filteredEntries = useMemo(() => {
    const term = keyword.trim().toLowerCase()
    return entries.filter((row) => {
      if (accountFilter !== 'all' && row.account_id !== accountFilter) return false
      if (kindFilter !== 'all' && row.kind !== kindFilter) return false
      if (categoryFilter !== 'all' && row.category_id !== categoryFilter) return false
      if (shopFilter !== 'all' && row.shop !== shopFilter) return false
      if (statusFilter === 'normal' && row.voided_at) return false
      if (statusFilter === 'voided' && !row.voided_at) return false
      if (dateRange.from && row.entry_date < dateRange.from) return false
      if (dateRange.to && row.entry_date > dateRange.to) return false
      if (term) {
        const haystack = [
          row.summary,
          row.remark ?? '',
          row.counterparty ?? '',
          row.reimbursee ?? '',
          row.shop ?? '',
          row.reference_no ?? '',
          row.account?.name ?? '',
          row.category?.name ?? '',
        ]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(term)) return false
      }
      return true
    })
  }, [entries, accountFilter, kindFilter, categoryFilter, shopFilter, statusFilter, dateRange, keyword])

  const expenseByCategory = useMemo(() => {
    const sums = new Map<string, number>()
    let total = 0
    for (const row of filteredEntries) {
      if (row.kind !== 'expense' || row.voided_at) continue
      const name = row.category?.name ?? '未分类'
      const amount = Number(row.amount_cny)
      sums.set(name, (sums.get(name) ?? 0) + amount)
      total += amount
    }
    return [...sums.entries()]
      .map(([name, amount]) => ({ name, amount, share: total > 0 ? amount / total : 0 }))
      .sort((a, b) => b.amount - a.amount)
  }, [filteredEntries])

  const monthFlowOf = (accountId: string) =>
    monthFlows.find((flow) => flow.account_id === accountId)

  // 月度汇总（行维度 × 月份矩阵，折合人民币，排除作废；维度=分类或报销人）
  const [summaryDim, setSummaryDim] = useState<'category' | 'reimbursee'>('category')
  const monthlySummary = useMemo(() => {
    const scoped = entries.filter(
      (row) => !row.voided_at && (summaryAccount === 'all' || row.account_id === summaryAccount),
    )
    const monthSet = new Set<string>()
    const rowSet = new Set<string>()
    const cellMap = new Map<string, number>()
    const monthIncome = new Map<string, number>()
    const monthExpense = new Map<string, number>()
    for (const row of scoped) {
      const month = row.entry_date.slice(0, 7)
      const key =
        summaryDim === 'category' ? (row.category?.name ?? '未分类') : (row.reimbursee ?? '未填写')
      monthSet.add(month)
      rowSet.add(key)
      const amount = Number(row.amount_cny)
      cellMap.set(`${key}|${month}`, (cellMap.get(`${key}|${month}`) ?? 0) + amount)
      if (row.kind === 'income') monthIncome.set(month, (monthIncome.get(month) ?? 0) + amount)
      else monthExpense.set(month, (monthExpense.get(month) ?? 0) + amount)
    }
    const months = [...monthSet].sort().reverse()
    const cell = (key: string, month: string) => cellMap.get(`${key}|${month}`) ?? 0
    const totalOf = (key: string) => months.reduce((sum, month) => sum + cell(key, month), 0)
    const rows = [...rowSet].sort((a, b) => {
      if (summaryDim === 'reimbursee') return totalOf(b) - totalOf(a)
      const kindOf = (name: string) =>
        scoped.find((row) => (row.category?.name ?? '未分类') === name)?.category?.kind ?? 'expense'
      return kindOf(a) === kindOf(b) ? a.localeCompare(b, 'zh') : kindOf(a) === 'income' ? -1 : 1
    })
    return {
      months,
      rows,
      cell,
      totalOf,
      incomeOf: (month: string) => monthIncome.get(month) ?? 0,
      expenseOf: (month: string) => monthExpense.get(month) ?? 0,
    }
  }, [entries, summaryAccount, summaryDim])

  function resetEntryForm() {
    setEditingEntry(null)
    setEntryAccount(activeAccounts[0]?.id ?? '')
    setEntryKind('expense')
    setEntryCategory('')
    setEntryCurrency('CNY')
    setEntryRate('1')
  }

  function openEntryDialog(entry?: FinanceJournalEntry) {
    if (entry) {
      setEditingEntry(entry)
      setEntryAccount(entry.account_id)
      setEntryKind(entry.kind)
      setEntryCategory(entry.category_id)
      setEntryCurrency(entry.currency)
      setEntryRate(String(entry.exchange_rate_to_cny))
    } else {
      resetEntryForm()
    }
    setEntryDialogOpen(true)
  }

  function handleEntryKindChange(value: FinanceTransactionType) {
    setEntryKind(value)
    setEntryCategory('')
  }

  function handleEntryAccountChange(value: string) {
    setEntryAccount(value)
    const account = accounts.find((a) => a.id === value)
    if (account) {
      setEntryCurrency(account.currency)
      setEntryRate(account.currency === 'CNY' ? '1' : '')
    }
  }

  function handleEntryCurrencyChange(value: CurrencyCode) {
    setEntryCurrency(value)
    setEntryRate(value === 'CNY' ? '1' : '')
  }

  function handleEntrySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    startTransition(async () => {
      const result = await saveJournalEntry(formData)
      if (!result.ok) {
        toastError(result)
        return
      }
      toast.success(editingEntry ? '分录已更新' : '分录已登记')
      setEntryDialogOpen(false)
      setEditingEntry(null)
      router.refresh()
    })
  }

  function handleVoidSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!voidTarget) return
    startTransition(async () => {
      const result = await voidJournalEntry({
        entry_id: voidTarget.id,
        void_reason: voidReason,
      })
      if (!result.ok) {
        toastError(result)
        return
      }
      toast.success('分录已作废')
      setVoidTarget(null)
      setVoidReason('')
      router.refresh()
    })
  }

  function handleAccountSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    startTransition(async () => {
      const result = await saveJournalAccount(formData)
      if (!result.ok) {
        toastError(result)
        return
      }
      toast.success(editingAccount ? '账户已更新' : '账户已创建')
      setEditingAccount(null)
      form.reset()
      router.refresh()
    })
  }

  function handleAccountDelete(account: FinanceJournalAccount) {
    if (!window.confirm(`确定删除账户「${account.name}」吗？已有分录的账户无法删除。`)) return
    startTransition(async () => {
      const result = await deleteJournalAccount(account.id)
      if (!result.ok) toastError(result)
      else {
        toast.success('账户已删除')
        router.refresh()
      }
    })
  }

  function handleCategorySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    startTransition(async () => {
      const result = await saveJournalCategory(formData)
      if (!result.ok) {
        toastError(result)
        return
      }
      toast.success(editingCategory ? '分类已更新' : '分类已创建')
      setEditingCategory(null)
      form.reset()
      router.refresh()
    })
  }

  function handleCategoryDelete(category: FinanceJournalCategory) {
    if (!window.confirm(`确定删除分类「${category.name}」吗？已被分录使用的分类无法删除。`)) return
    startTransition(async () => {
      const result = await deleteJournalCategory(category.id)
      if (!result.ok) toastError(result)
      else {
        toast.success('分类已删除')
        router.refresh()
      }
    })
  }

  // 流水导入
  const importAccountCurrency: CurrencyCode =
    accounts.find((account) => account.id === importAccount)?.currency ?? 'CNY'

  function openImportDialog() {
    setImportTab('csv')
    setImportAccount(activeAccounts[0]?.id ?? '')
    setImportRate('1')
    setImportText('')
    setImportFileName('')
    setPreviewRows(null)
    setImportDialogOpen(true)
  }

  function resetImportPreview() {
    setPreviewRows(null)
  }

  function handleImportAccountChange(value: string) {
    setImportAccount(value)
    const account = accounts.find((a) => a.id === value)
    setImportRate(account?.currency === 'CNY' || !account ? '1' : '')
    setPreviewRows(null)
  }

  function handleImportFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setImportText(typeof reader.result === 'string' ? reader.result : '')
      setImportFileName(file.name)
      setPreviewRows(null)
    }
    reader.readAsText(file, 'utf-8')
  }

  function handleImportParse() {
    const text = importText.trim()
    if (!text) {
      toast.error(importTab === 'csv' ? '请先选择招行 CSV 文件' : '请先粘贴对账单文本')
      return
    }
    if (!importAccount) {
      toast.error('请选择要导入的银行账户')
      return
    }
    const rows = importTab === 'csv' ? parseCmbCsv(text) : parseBocStatementText(text)
    if (rows.length === 0) {
      toast.error('未解析到流水行，请确认文件/文本格式与所选方式一致')
      return
    }
    startTransition(async () => {
      const result = await previewJournalImport({ account_id: importAccount, rows })
      if (!result.ok || !result.rows) {
        toastError(result)
        return
      }
      setPreviewRows(
        result.rows.map((row) => ({
          ...row,
          checked: !row.duplicate,
        })),
      )
    })
  }

  function patchPreviewRow(index: number, patch: Partial<ImportPreviewRow>) {
    setPreviewRows((current) =>
      current ? current.map((row, i) => (i === index ? { ...row, ...patch } : row)) : current,
    )
  }

  function handleImportConfirm() {
    if (!previewRows) return
    const rows = previewRows
      .filter((row) => row.checked && row.category_id)
      .map((row) => ({
        entry_date: row.entry_date,
        kind: row.kind,
        amount_original: row.amount_original,
        summary: row.summary,
        counterparty: row.counterparty ?? '',
        reference_no: row.reference_no ?? '',
        category_id: row.category_id as string,
        reimbursee: row.reimbursee ?? '',
        shop: row.shop ?? '',
      }))
    if (rows.length === 0) {
      toast.error('没有可入账的行：请至少勾选一行并选好分类')
      return
    }
    startTransition(async () => {
      const result = await importJournalEntries({
        account_id: importAccount,
        exchange_rate_to_cny: Number(importRate || '1'),
        rows,
      })
      if (!result.ok) {
        toastError(result)
        return
      }
      toast.success(`已导入 ${result.inserted ?? rows.length} 条流水`)
      setImportDialogOpen(false)
      setPreviewRows(null)
      router.refresh()
    })
  }

  function handleRuleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    startTransition(async () => {
      const result = await saveJournalImportRule(formData)
      if (!result.ok) {
        toastError(result)
        return
      }
      toast.success('规则已保存')
      form.reset()
      router.refresh()
    })
  }

  function handleRuleDelete(rule: FinanceJournalImportRule) {
    const target = rule.category?.name ?? (rule.shop ? `店铺「${rule.shop}」` : '')
    if (!window.confirm(`确定删除规则「${rule.keyword} → ${target}」吗？`)) return
    startTransition(async () => {
      const result = await deleteJournalImportRule(rule.id)
      if (!result.ok) toastError(result)
      else {
        toast.success('规则已删除')
        router.refresh()
      }
    })
  }

  function handleExport() {
    startTransition(async () => {
      const response = await fetch('/api/finance/journal/export/xlsx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: filteredEntries.map((row) => row.id) }),
      })
      if (!response.ok) {
        toast.error('导出失败，请稍后重试')
        return
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `财务日记账_${todayString()}.xlsx`
      anchor.click()
      URL.revokeObjectURL(url)
    })
  }

  const totalIncomeCny = balances.reduce((sum, b) => sum + Number(b.total_income_cny), 0)
  const totalExpenseCny = balances.reduce((sum, b) => sum + Number(b.total_expense_cny), 0)

  return (
    <div className="space-y-6">
      <datalist id="journal-member-options">
        {members.map((member) => (
          <option key={member.id} value={displayProfileName(member)} />
        ))}
      </datalist>
      {/* 账户余额 */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {balances.map((balance) => {
          const flow = monthFlowOf(balance.account_id)
          return (
            <div key={balance.account_id} className="rounded-lg border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium text-muted-foreground">
                  {balance.name}
                </p>
                <Badge variant="secondary">{balance.currency}</Badge>
              </div>
              <p className="mt-2 text-2xl font-semibold">
                {formatCurrency(Number(balance.balance), balance.currency)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                本月 +{formatCurrency(flow?.income ?? 0, balance.currency)} / −
                {formatCurrency(flow?.expense ?? 0, balance.currency)}　期初{' '}
                {formatCurrency(Number(balance.initial_balance), balance.currency)}
              </p>
            </div>
          )
        })}
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <p className="text-sm font-medium text-muted-foreground">全部账户流水折 CNY</p>
          <p className="mt-2 text-2xl font-semibold">{formatCny(totalIncomeCny - totalExpenseCny)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            收入 {formatCny(totalIncomeCny)} / 支出 {formatCny(totalExpenseCny)}（仅流水折算，不含各账户期初）
          </p>
        </div>
      </div>

      {/* 钱花在哪里 */}
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">钱花在哪里（当前筛选范围，按折合人民币）</h2>
          <span className="text-xs text-muted-foreground">
            支出合计 {formatCny(expenseByCategory.reduce((sum, item) => sum + item.amount, 0))}
          </span>
        </div>
        {expenseByCategory.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            当前筛选范围内没有支出记录
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {expenseByCategory.slice(0, 10).map((item) => (
              <div key={item.name} className="flex items-center gap-3">
                <span className="w-24 shrink-0 truncate text-sm">{item.name}</span>
                <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
                  <div
                    className="h-full rounded bg-primary"
                    style={{ width: `${Math.max(2, item.share * 100)}%` }}
                  />
                </div>
                <span className="w-28 shrink-0 text-right text-sm">{formatCny(item.amount)}</span>
                <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">
                  {(item.share * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 筛选条 + 操作 */}
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker
          from={dateRange.from}
          to={dateRange.to}
          onChange={(range) => setDateRange(range)}
        />
        <Select value={accountFilter} onValueChange={setAccountFilter}>
          <SelectTrigger className="w-40"><SelectValue placeholder="账户" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部账户</SelectItem>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as typeof kindFilter)}>
          <SelectTrigger className="w-28"><SelectValue placeholder="类型" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            <SelectItem value="income">收入</SelectItem>
            <SelectItem value="expense">支出</SelectItem>
          </SelectContent>
        </Select>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-36"><SelectValue placeholder="分类" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部分类</SelectItem>
            {categories.map((category) => (
              <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="w-28"><SelectValue placeholder="状态" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="normal">正常</SelectItem>
            <SelectItem value="voided">已作废</SelectItem>
          </SelectContent>
        </Select>
        {shopOptions.length > 0 && (
          <Select value={shopFilter} onValueChange={setShopFilter}>
            <SelectTrigger className="w-32"><SelectValue placeholder="店铺" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部店铺</SelectItem>
              {shopOptions.map((shop) => (
                <SelectItem key={shop} value={shop}>{shop}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索摘要 / 对方 / 店铺 / 备注"
          className="w-52"
        />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={() => { setSummaryOpen(true); setSummaryAccount('all') }}>
            <BarChart3 className="h-4 w-4" />
            月度汇总
          </Button>
          <Button variant="outline" onClick={openImportDialog}>
            <FileUp className="h-4 w-4" />
            导入
          </Button>
          <Button variant="outline" onClick={handleExport} disabled={pending || filteredEntries.length === 0}>
            <Download className="h-4 w-4" />
            导出
          </Button>
          <Button variant="outline" onClick={() => { setEditingAccount(null); setAccountDialogOpen(true) }}>
            <Settings2 className="h-4 w-4" />
            账户管理
          </Button>
          <Button variant="outline" onClick={() => { setEditingCategory(null); setCategoryDialogOpen(true) }}>
            <Tags className="h-4 w-4" />
            分类管理
          </Button>
          <Button onClick={() => openEntryDialog()}>
            <Plus className="h-4 w-4" />
            记一笔
          </Button>
        </div>
      </div>

      {/* 流水表 */}
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">日期</TableHead>
              <TableHead>账户</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>分类</TableHead>
              <TableHead>摘要</TableHead>
              <TableHead className="w-20">店铺</TableHead>
              <TableHead className="text-right">原币金额</TableHead>
              <TableHead className="text-right">折合 CNY</TableHead>
              <TableHead className="w-28 text-right">结余（账户币种）</TableHead>
              <TableHead>登记人</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredEntries.map((row) => (
              <TableRow key={row.id} className={cn(row.voided_at && 'opacity-50')}>
                <TableCell className={cn(row.voided_at && 'line-through')}>
                  {formatDate(row.entry_date)}
                </TableCell>
                <TableCell>{row.account?.name ?? '—'}</TableCell>
                <TableCell>
                  <Badge variant={row.kind === 'income' ? 'success' : 'secondary'}>
                    {FINANCE_TRANSACTION_LABELS[row.kind]}
                  </Badge>
                </TableCell>
                <TableCell>{row.category?.name ?? '—'}</TableCell>
                <TableCell>
                  <div className={cn('font-medium', row.voided_at && 'line-through')}>{row.summary}</div>
                  <div className="text-xs text-muted-foreground">
                    {row.voided_at
                      ? `已作废：${row.void_reason ?? ''}`
                      : [
                          row.counterparty ? `对方：${row.counterparty}` : '',
                          row.reimbursee ? `报销：${row.reimbursee}` : '',
                          row.reference_no ? `流水：${row.reference_no}` : '',
                          row.remark ?? '',
                        ]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                  </div>
                </TableCell>
                <TableCell>
                  {row.shop ? <Badge variant="outline">{row.shop}</Badge> : '—'}
                </TableCell>
                <TableCell
                  className={cn(
                    'text-right',
                    row.kind === 'income' ? 'text-emerald-600' : 'text-destructive',
                    row.voided_at && 'line-through',
                  )}
                >
                  {row.kind === 'income' ? '+' : '−'}
                  {formatCurrency(Number(row.amount_original), row.currency)}
                </TableCell>
                <TableCell className={cn('text-right font-medium', row.voided_at && 'line-through')}>
                  {formatCny(Number(row.amount_cny))}
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {row.voided_at
                    ? '—'
                    : formatCurrency(runningBalances[row.id] ?? 0, row.account?.currency ?? 'CNY')}
                </TableCell>
                <TableCell>{displayProfileName(row.creator)}</TableCell>
                <TableCell>
                  {row.voided_at ? (
                    <Badge variant="outline">已作废</Badge>
                  ) : (
                    <div className="flex items-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={pending}
                        onClick={() => openEntryDialog(row)}
                        aria-label="编辑分录"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={pending}
                        onClick={() => { setVoidTarget(row); setVoidReason('') }}
                        aria-label="作废分录"
                      >
                        <Ban className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {filteredEntries.length === 0 && (
              <TableRow>
                <TableCell colSpan={11} className="py-12 text-center text-muted-foreground">
                  暂无日记账记录
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* 导入银行流水 */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>导入银行流水</DialogTitle>
            <DialogDescription>
              支持招商银行 CSV 文件、或粘贴中国银行对账单文本；系统按关键词规则建议分类并标出疑似重复，确认后才入账。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>银行账户</Label>
                <Select value={importAccount} onValueChange={handleImportAccountChange}>
                  <SelectTrigger><SelectValue placeholder="选择账户" /></SelectTrigger>
                  <SelectContent>
                    {activeAccounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.name}（{account.currency}）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>导入方式</Label>
                <Select
                  value={importTab}
                  onValueChange={(value) => {
                    setImportTab(value as 'csv' | 'text')
                    setPreviewRows(null)
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="csv">招行 CSV 文件</SelectItem>
                    <SelectItem value="text">粘贴对账单文本（中行等）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {importAccountCurrency !== 'CNY' && (
                <div className="space-y-2">
                  <Label>兑人民币汇率（{importAccountCurrency}）</Label>
                  <Input
                    type="number"
                    min="0"
                    max="1000000"
                    step="0.0001"
                    value={importRate}
                    onChange={(event) => setImportRate(event.target.value)}
                    required
                  />
                </div>
              )}
            </div>

            {importTab === 'csv' ? (
              <div className="space-y-2">
                <Label htmlFor="journal-import-file">选择文件</Label>
                <Input
                  id="journal-import-file"
                  ref={importFileRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleImportFileChange}
                />
                {importFileName && (
                  <p className="text-xs text-muted-foreground">已读取：{importFileName}</p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="journal-import-text">对账单文本</Label>
                <Textarea
                  id="journal-import-text"
                  value={importText}
                  onChange={(event) => { setImportText(event.target.value); setPreviewRows(null) }}
                  placeholder="打开银行对账单，全选复制表格文本后粘贴到这里"
                  className="min-h-32 font-mono text-xs"
                />
              </div>
            )}

            {!previewRows && (
              <div className="flex justify-end">
                <Button onClick={handleImportParse} disabled={pending}>
                  {pending ? '解析中…' : '解析并匹配'}
                </Button>
              </div>
            )}

            {previewRows && (
              <>
                <div className="flex items-center justify-between text-sm">
                  <p className="text-muted-foreground">
                    共 {previewRows.length} 行，其中疑似重复{' '}
                    {previewRows.filter((row) => row.duplicate).length} 行（已默认取消勾选，确认要重复入账可手动勾选）
                  </p>
                  <Button variant="ghost" size="sm" onClick={resetImportPreview}>
                    重新解析
                  </Button>
                </div>
                <div className="max-h-80 overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead className="w-24">日期</TableHead>
                        <TableHead className="w-16">类型</TableHead>
                        <TableHead>摘要</TableHead>
                        <TableHead className="w-28 text-right">金额</TableHead>
                        <TableHead className="w-32">分类</TableHead>
                        <TableHead className="w-24">店铺</TableHead>
                        <TableHead className="w-24">报销人</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewRows.map((row, index) => (
                        <TableRow key={index} className={cn(row.duplicate && 'bg-amber-50')}>
                          <TableCell>
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-primary"
                              checked={row.checked}
                              onChange={(event) =>
                                patchPreviewRow(index, { checked: event.target.checked })
                              }
                              aria-label="选择入账"
                            />
                          </TableCell>
                          <TableCell>{formatDate(row.entry_date)}</TableCell>
                          <TableCell>
                            <Badge variant={row.kind === 'income' ? 'success' : 'secondary'}>
                              {FINANCE_TRANSACTION_LABELS[row.kind]}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="max-w-56 truncate text-sm" title={row.summary}>
                              {row.summary}
                            </div>
                            {row.counterparty && (
                              <div className="max-w-56 truncate text-xs text-muted-foreground">
                                对方：{row.counterparty}
                              </div>
                            )}
                            {row.duplicate && (
                              <Badge variant="outline" className="mt-1 border-amber-400 text-amber-600">
                                疑似重复
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell
                            className={cn(
                              'text-right',
                              row.kind === 'income' ? 'text-emerald-600' : 'text-destructive',
                            )}
                          >
                            {row.kind === 'income' ? '+' : '−'}
                            {formatCurrency(row.amount_original, importAccountCurrency)}
                          </TableCell>
                          <TableCell>
                            <Select
                              value={row.category_id ?? ''}
                              onValueChange={(value) => patchPreviewRow(index, { category_id: value })}
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue placeholder="待选择" />
                              </SelectTrigger>
                              <SelectContent>
                                {categories
                                  .filter((category) => category.kind === row.kind && category.is_active)
                                  .map((category) => (
                                    <SelectItem key={category.id} value={category.id}>
                                      {category.name}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Input
                              className="h-8 px-2 text-xs"
                              value={row.shop ?? ''}
                              placeholder="建议：店铺"
                              onChange={(event) => patchPreviewRow(index, { shop: event.target.value })}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              className="h-8 px-2 text-xs"
                              value={row.reimbursee ?? ''}
                              placeholder="建议：报销人"
                              list="journal-member-options"
                              onChange={(event) => patchPreviewRow(index, { reimbursee: event.target.value })}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setImportDialogOpen(false)}>取消</Button>
                  <Button onClick={handleImportConfirm} disabled={pending}>
                    {pending
                      ? '导入中…'
                      : `确认导入 ${previewRows.filter((row) => row.checked && row.category_id).length} 条`}
                  </Button>
                </DialogFooter>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 记一笔 / 编辑 */}
      <Dialog open={entryDialogOpen} onOpenChange={setEntryDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingEntry ? '编辑分录' : '记一笔'}</DialogTitle>
            <DialogDescription>
              登记银行账户的收入或支出；账户与分类可在「账户管理」「分类管理」中维护。
            </DialogDescription>
          </DialogHeader>
          <form key={editingEntry?.id ?? 'new'} className="grid gap-4 sm:grid-cols-2" onSubmit={handleEntrySubmit}>
            {editingEntry && <input type="hidden" name="entry_id" value={editingEntry.id} />}
            <div className="space-y-2">
              <Label htmlFor="journal-account">银行账户</Label>
              <Select name="account_id" value={entryAccount} onValueChange={handleEntryAccountChange} required>
                <SelectTrigger id="journal-account"><SelectValue placeholder="选择账户" /></SelectTrigger>
                <SelectContent>
                  {activeAccounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="journal-kind">类型</Label>
              <Select name="kind" value={entryKind} onValueChange={(v) => handleEntryKindChange(v as FinanceTransactionType)}>
                <SelectTrigger id="journal-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="income">收入</SelectItem>
                  <SelectItem value="expense">支出</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="journal-category">分类</Label>
              <Select name="category_id" value={entryCategory} onValueChange={setEntryCategory} required>
                <SelectTrigger id="journal-category"><SelectValue placeholder="选择分类" /></SelectTrigger>
                <SelectContent>
                  {kindCategories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="journal-date">日期</Label>
              <Input
                id="journal-date"
                name="entry_date"
                type="date"
                defaultValue={editingEntry?.entry_date ?? todayString()}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="journal-amount">金额</Label>
              <Input
                id="journal-amount"
                name="amount_original"
                type="number"
                min="0.0001"
                step="0.0001"
                defaultValue={editingEntry ? String(Number(editingEntry.amount_original)) : ''}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="journal-currency">币种</Label>
              <Select
                name="currency"
                value={entryCurrency}
                onValueChange={(v) => handleEntryCurrencyChange(v as CurrencyCode)}
              >
                <SelectTrigger id="journal-currency"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {financeCurrencies.map((code) => (
                    <SelectItem key={code} value={code}>{code}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="journal-rate">兑人民币汇率</Label>
              <Input
                id="journal-rate"
                name="exchange_rate_to_cny"
                type="number"
                min="0"
                max="1000000"
                step="0.0001"
                value={entryRate}
                onChange={(event) => setEntryRate(event.target.value)}
                readOnly={entryCurrency === 'CNY'}
                required
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="journal-summary">摘要</Label>
              <Input
                id="journal-summary"
                name="summary"
                placeholder="例如：支付 10 月供应商货款"
                defaultValue={editingEntry?.summary ?? ''}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="journal-counterparty">收/付款人（可选）</Label>
              <Input
                id="journal-counterparty"
                name="counterparty"
                placeholder="例如：顺丰速运"
                defaultValue={editingEntry?.counterparty ?? ''}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="journal-reimbursee">报销人（可选）</Label>
              <Input
                id="journal-reimbursee"
                name="reimbursee"
                placeholder="用于按人统计报销"
                list="journal-member-options"
                defaultValue={editingEntry?.reimbursee ?? ''}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="journal-shop">店铺（可选）</Label>
              <Input
                id="journal-shop"
                name="shop"
                placeholder="例如：国际站 / 1688 / 社媒"
                defaultValue={editingEntry?.shop ?? ''}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="journal-reference">流水号（可选）</Label>
              <Input
                id="journal-reference"
                name="reference_no"
                placeholder="银行流水号 / 凭证号"
                defaultValue={editingEntry?.reference_no ?? ''}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="journal-remark">备注（可选）</Label>
              <Input
                id="journal-remark"
                name="remark"
                placeholder="可写订单号 / PI 号等参考信息"
                defaultValue={editingEntry?.remark ?? ''}
              />
            </div>
            <DialogFooter className="sm:col-span-2">
              <Button type="submit" disabled={pending}>{pending ? '保存中…' : '保存'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 作废 */}
      <Dialog open={voidTarget !== null} onOpenChange={(open) => { if (!open) setVoidTarget(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>作废分录</DialogTitle>
            <DialogDescription>
              {voidTarget ? `「${voidTarget.summary}」作废后不可恢复、不可再编辑，余额统计将剔除该笔。` : ''}
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleVoidSubmit}>
            <div className="space-y-2">
              <Label htmlFor="journal-void-reason">作废原因</Label>
              <Input
                id="journal-void-reason"
                value={voidReason}
                onChange={(event) => setVoidReason(event.target.value)}
                placeholder="请填写作废原因"
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setVoidTarget(null)}>取消</Button>
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending ? '作废中…' : '确认作废'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 账户管理 */}
      <Dialog open={accountDialogOpen} onOpenChange={setAccountDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>银行账户管理</DialogTitle>
            <DialogDescription>
              新建账户时请填写期初余额（即当前实际余额），之后余额由日记账自动累计。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-48 overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>账户名称</TableHead>
                  <TableHead>币种</TableHead>
                  <TableHead className="text-right">期初余额</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((account) => (
                  <TableRow key={account.id}>
                    <TableCell className="font-medium">{account.name}</TableCell>
                    <TableCell>{account.currency}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(Number(account.initial_balance), account.currency)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={account.is_active ? 'success' : 'secondary'}>
                        {account.is_active ? '启用' : '停用'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setEditingAccount(account)}
                          aria-label="编辑账户"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={pending}
                          onClick={() => handleAccountDelete(account)}
                          aria-label="删除账户"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {accounts.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      还没有银行账户，请在下方新建
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <form
            key={editingAccount?.id ?? 'new-account'}
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={handleAccountSubmit}
          >
            {editingAccount && <input type="hidden" name="account_id" value={editingAccount.id} />}
            <div className="space-y-2">
              <Label htmlFor="account-name">账户名称</Label>
              <Input
                id="account-name"
                name="name"
                placeholder="例如：招行对公-基本户"
                defaultValue={editingAccount?.name ?? ''}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="account-currency">币种</Label>
              <Select
                name="currency"
                defaultValue={editingAccount?.currency ?? 'CNY'}
                disabled={Boolean(editingAccount)}
              >
                <SelectTrigger id="account-currency"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {financeCurrencies.map((code) => (
                    <SelectItem key={code} value={code}>{code}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="account-initial-balance">期初余额</Label>
              <Input
                id="account-initial-balance"
                name="initial_balance"
                type="number"
                min="-999999999999"
                max="999999999999"
                step="0.0001"
                defaultValue={editingAccount ? String(Number(editingAccount.initial_balance)) : '0'}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="account-active">状态</Label>
              <Select name="is_active" defaultValue={editingAccount ? String(editingAccount.is_active) : 'true'}>
                <SelectTrigger id="account-active"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">启用</SelectItem>
                  <SelectItem value="false">停用</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter className="sm:col-span-2">
              {editingAccount && (
                <Button type="button" variant="outline" onClick={() => setEditingAccount(null)}>
                  取消编辑
                </Button>
              )}
              <Button type="submit" disabled={pending}>
                {pending ? '保存中…' : editingAccount ? '保存修改' : '新建账户'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 分类管理 */}
      <Dialog open={categoryDialogOpen} onOpenChange={setCategoryDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>收支分类管理</DialogTitle>
            <DialogDescription>
              分类用于统计钱花在哪里；已被分录使用的分类不能删除，可改为停用。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-48 overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>分类名称</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead className="text-right">排序</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.map((category) => (
                  <TableRow key={category.id}>
                    <TableCell className="font-medium">{category.name}</TableCell>
                    <TableCell>
                      <Badge variant={category.kind === 'income' ? 'success' : 'secondary'}>
                        {FINANCE_TRANSACTION_LABELS[category.kind]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{category.sort_order}</TableCell>
                    <TableCell>
                      <Badge variant={category.is_active ? 'success' : 'secondary'}>
                        {category.is_active ? '启用' : '停用'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setEditingCategory(category)}
                          aria-label="编辑分类"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={pending}
                          onClick={() => handleCategoryDelete(category)}
                          aria-label="删除分类"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <form
            key={editingCategory?.id ?? 'new-category'}
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={handleCategorySubmit}
          >
            {editingCategory && <input type="hidden" name="category_id" value={editingCategory.id} />}
            <div className="space-y-2">
              <Label htmlFor="category-name">分类名称</Label>
              <Input
                id="category-name"
                name="name"
                placeholder="例如：市场推广"
                defaultValue={editingCategory?.name ?? ''}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="category-kind">类型</Label>
              <Select
                name="kind"
                defaultValue={editingCategory?.kind ?? 'expense'}
                disabled={Boolean(editingCategory)}
              >
                <SelectTrigger id="category-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="income">收入</SelectItem>
                  <SelectItem value="expense">支出</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="category-sort">排序（小的在前）</Label>
              <Input
                id="category-sort"
                name="sort_order"
                type="number"
                min="0"
                max="9999"
                step="1"
                defaultValue={editingCategory?.sort_order ?? 10}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="category-active">状态</Label>
              <Select name="is_active" defaultValue={editingCategory ? String(editingCategory.is_active) : 'true'}>
                <SelectTrigger id="category-active"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">启用</SelectItem>
                  <SelectItem value="false">停用</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter className="sm:col-span-2">
              {editingCategory && (
                <Button type="button" variant="outline" onClick={() => setEditingCategory(null)}>
                  取消编辑
                </Button>
              )}
              <Button type="submit" disabled={pending}>
                {pending ? '保存中…' : editingCategory ? '保存修改' : '新建分类'}
              </Button>
            </DialogFooter>
          </form>

          {/* 导入匹配规则 */}
          <div className="space-y-3 border-t pt-4">
            <div>
              <h3 className="text-sm font-semibold">导入匹配规则</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                导入银行流水时按摘要关键词自动建议分类或店铺，命中多条取最长关键词；预览时仍可逐行修改。
              </p>
            </div>
            {rules.length > 0 && (
              <div className="flex max-h-28 flex-wrap gap-2 overflow-auto">
                {rules.map((rule) => (
                  <span
                    key={rule.id}
                    className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-1 text-xs"
                  >
                    {rule.keyword} → {rule.category?.name ?? (rule.shop ? `店铺「${rule.shop}」` : '—')}
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => handleRuleDelete(rule)}
                      aria-label={`删除规则 ${rule.keyword}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <form className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]" onSubmit={handleRuleSubmit}>
              <Input name="keyword" placeholder="关键词，如：顺丰" required />
              <Select name="category_id">
                <SelectTrigger><SelectValue placeholder="匹配到分类（可与店铺二选一）" /></SelectTrigger>
                <SelectContent>
                  {categories
                    .filter((category) => category.is_active)
                    .map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {FINANCE_TRANSACTION_LABELS[category.kind]} · {category.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Input name="shop" placeholder="或填店铺，如：国际站" />
              <Button type="submit" size="sm" variant="outline" disabled={pending}>
                <Plus className="h-4 w-4" />
                添加
              </Button>
            </form>
          </div>
        </DialogContent>
      </Dialog>

      {/* 月度汇总：行维度（分类/报销人）× 月份矩阵（折合人民币，排除作废） */}
      <Dialog open={summaryOpen} onOpenChange={setSummaryOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>月度汇总</DialogTitle>
            <DialogDescription>
              按分类或报销人 × 月份统计收支（折合人民币，排除作废），替代财务手工汇总表。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-40">
                <Select value={summaryDim} onValueChange={(v) => setSummaryDim(v as typeof summaryDim)}>
                  <SelectTrigger><SelectValue placeholder="汇总维度" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="category">按分类</SelectItem>
                    <SelectItem value="reimbursee">按报销人</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="w-56">
                <Select value={summaryAccount} onValueChange={setSummaryAccount}>
                  <SelectTrigger><SelectValue placeholder="账户" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部账户</SelectItem>
                    {accounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {monthlySummary.months.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">所选范围内暂无日记账记录</p>
            ) : (
              <div className="max-h-96 overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="sticky left-0 bg-muted">
                        {summaryDim === 'category' ? '分类' : '报销人'}
                      </TableHead>
                      {monthlySummary.months.map((month) => (
                        <TableHead key={month} className="text-right">{month}</TableHead>
                      ))}
                      <TableHead className="text-right">合计</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {monthlySummary.rows.map((rowKey) => {
                      const total = monthlySummary.totalOf(rowKey)
                      const kind =
                        summaryDim === 'category'
                          ? entries.find(
                              (row) => (row.category?.name ?? '未分类') === rowKey,
                            )?.category?.kind
                          : undefined
                      return (
                        <TableRow key={rowKey}>
                          <TableCell className="sticky left-0 bg-card font-medium">
                            {summaryDim === 'category' && (
                              <>
                                <Badge variant={kind === 'income' ? 'success' : 'secondary'}>
                                  {FINANCE_TRANSACTION_LABELS[kind as FinanceTransactionType] ?? '—'}
                                </Badge>{' '}
                              </>
                            )}
                            {rowKey}
                          </TableCell>
                          {monthlySummary.months.map((month) => (
                            <TableCell key={month} className="text-right text-sm">
                              {monthlySummary.cell(rowKey, month) > 0
                                ? formatCny(monthlySummary.cell(rowKey, month))
                                : '—'}
                            </TableCell>
                          ))}
                          <TableCell className="text-right text-sm font-medium">
                            {formatCny(total)}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                    {([
                      { label: '收入合计', pick: monthlySummary.incomeOf, cls: 'text-emerald-600' },
                      { label: '支出合计', pick: monthlySummary.expenseOf, cls: 'text-destructive' },
                    ] as const).map(({ label, pick, cls }) => (
                      <TableRow key={label} className="border-t-2 font-medium">
                        <TableCell className="sticky left-0 bg-card">{label}</TableCell>
                        {monthlySummary.months.map((month) => (
                          <TableCell key={month} className={cn('text-right text-sm', cls)}>
                            {formatCny(pick(month))}
                          </TableCell>
                        ))}
                        <TableCell className={cn('text-right text-sm', cls)}>
                          {formatCny(monthlySummary.months.reduce((sum, month) => sum + pick(month), 0))}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-medium">
                      <TableCell className="sticky left-0 bg-card">月度净额</TableCell>
                      {monthlySummary.months.map((month) => (
                        <TableCell
                          key={month}
                          className={cn(
                            'text-right text-sm',
                            monthlySummary.incomeOf(month) - monthlySummary.expenseOf(month) >= 0
                              ? 'text-emerald-600'
                              : 'text-destructive',
                          )}
                        >
                          {formatCny(monthlySummary.incomeOf(month) - monthlySummary.expenseOf(month))}
                        </TableCell>
                      ))}
                      <TableCell className="text-right text-sm">
                        {formatCny(
                          monthlySummary.months.reduce(
                            (sum, month) =>
                              sum + monthlySummary.incomeOf(month) - monthlySummary.expenseOf(month),
                            0,
                          ),
                        )}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
