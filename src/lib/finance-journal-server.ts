import { journalRunningBalances } from '@/lib/finance-journal'
import type { createClient } from '@/lib/supabase/server'
import type { FinanceJournalAccount, FinanceJournalEntry } from '@/types'

const BATCH_SIZE = 500

type PageResult = { data: unknown[] | null; error: { message: string } | null }

export async function fetchAllJournalRows<T>(fetchPage: (from: number, to: number) => PromiseLike<PageResult>): Promise<T[]> {
  const rows: T[] = []
  for (;;) {
    const { data, error } = await fetchPage(rows.length, rows.length + BATCH_SIZE - 1)
    if (error) throw new Error(error.message)
    if (!data?.length) return rows
    rows.push(...data as T[])
  }
}

export async function fetchJournalData(supabase: Awaited<ReturnType<typeof createClient>>) {
  const [accounts, entries] = await Promise.all([
    fetchAllJournalRows<FinanceJournalAccount>((from, to) => supabase
      .from('finance_journal_accounts').select('*').order('name').order('id').range(from, to)),
    fetchAllJournalRows<FinanceJournalEntry>((from, to) => supabase
      .from('finance_journal_entries')
      .select('*, account:finance_journal_accounts(id, name, currency), category:finance_journal_categories(id, name, kind), creator:profiles!finance_journal_entries_created_by_fkey(id, chinese_name, full_name, email)')
      .order('entry_date').order('created_at').order('id').range(from, to)),
  ])
  return { accounts, entries: [...entries].reverse(), runningBalances: journalRunningBalances(accounts, entries) }
}
