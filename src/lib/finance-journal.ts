import { z } from 'zod'
import type { FinanceJournalAccount, FinanceJournalEntry } from '@/types'

const dateFilter = z.string().refine((value) => {
  if (!value) return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}, '日期格式错误')
const idFilter = z.union([z.literal('all'), z.string().uuid()])

export const journalFiltersSchema = z.object({
  from: dateFilter.default(''),
  to: dateFilter.default(''),
  account: idFilter.default('all'),
  kind: z.enum(['all', 'income', 'expense']).default('all'),
  category: idFilter.default('all'),
  status: z.enum(['all', 'normal', 'voided']).default('all'),
  shop: z.string().max(200).default('all'),
  reimbursee: z.string().max(200).default('all'),
  keyword: z.string().trim().max(500).default(''),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, '开始日期不能晚于结束日期')

export type JournalFilters = z.infer<typeof journalFiltersSchema>
export const DEFAULT_JOURNAL_FILTERS: JournalFilters = journalFiltersSchema.parse({})

export function journalMonthRange(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null
  const from = `${month}-01`
  const date = new Date(`${from}T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + 1, 0)
  return { from, to: date.toISOString().slice(0, 10) }
}

export function filterJournalEntries(entries: FinanceJournalEntry[], filters: JournalFilters) {
  const term = filters.keyword.trim().toLowerCase()
  return entries.filter((row) => {
    if (filters.account !== 'all' && row.account_id !== filters.account) return false
    if (filters.kind !== 'all' && row.kind !== filters.kind) return false
    if (filters.category !== 'all' && row.category_id !== filters.category) return false
    if (filters.shop !== 'all' && row.shop !== filters.shop) return false
    if (filters.reimbursee !== 'all' && row.reimbursee !== filters.reimbursee) return false
    if (filters.status === 'normal' && row.voided_at) return false
    if (filters.status === 'voided' && !row.voided_at) return false
    if (filters.from && row.entry_date < filters.from) return false
    if (filters.to && row.entry_date > filters.to) return false
    if (!term) return true
    return [row.summary, row.remark, row.counterparty, row.reimbursee, row.shop,
      row.reference_no, row.account?.name, row.category?.name]
      .filter(Boolean).join(' ').toLowerCase().includes(term)
  })
}

export function journalTotals(entries: FinanceJournalEntry[]) {
  let income = 0
  let expense = 0
  let voided = 0
  for (const row of entries) {
    if (row.voided_at) { voided += 1; continue }
    if (row.kind === 'income') income += Number(row.amount_cny)
    else expense += Number(row.amount_cny)
  }
  return { income, expense, net: income - expense, voided, normal: entries.length - voided }
}

export function journalRunningBalances(accounts: FinanceJournalAccount[], chronologicalEntries: FinanceJournalEntry[]) {
  const balances = new Map(accounts.map((account) => [account.id, Number(account.initial_balance)]))
  const running: Record<string, number> = {}
  for (const row of chronologicalEntries) {
    if (row.voided_at) continue
    const next = Number(((balances.get(row.account_id) ?? 0) +
      (row.kind === 'income' ? Number(row.amount_original) : -Number(row.amount_original))).toFixed(4))
    balances.set(row.account_id, next)
    running[row.id] = next
  }
  return running
}
