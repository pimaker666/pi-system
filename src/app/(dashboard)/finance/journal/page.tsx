import { JournalManager } from '@/components/finance/journal-manager'
import { requireFinanceView } from '@/lib/auth'
import { chinaToday } from '@/lib/daily-order-costs-server'
import { createClient } from '@/lib/supabase/server'
import type {
  FinanceJournalAccount,
  FinanceJournalAccountBalance,
  FinanceJournalCategory,
  FinanceJournalEntry,
  FinanceJournalImportRule,
  Profile,
} from '@/types'

const LIST_LIMIT = 2000

export default async function FinanceJournalPage() {
  await requireFinanceView()
  const supabase = await createClient()

  const monthStart = `${chinaToday().slice(0, 7)}-01`
  const [
    accountsResult,
    categoriesResult,
    entriesResult,
    balancesResult,
    monthFlowsResult,
    rulesResult,
    historyResult,
    membersResult,
  ] = await Promise.all([
      supabase.from('finance_journal_accounts').select('*').order('name'),
      supabase
        .from('finance_journal_categories')
        .select('*')
        .order('kind')
        .order('sort_order'),
      supabase
        .from('finance_journal_entries')
        .select(
          '*, account:finance_journal_accounts(id, name, currency), category:finance_journal_categories(id, name, kind), creator:profiles!finance_journal_entries_created_by_fkey(id, chinese_name, full_name, email)',
        )
        .order('entry_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(LIST_LIMIT),
      supabase.from('finance_journal_account_balances').select('*'),
      supabase
        .from('finance_journal_entries')
        .select('account_id, kind, amount_original')
        .is('voided_at', null)
        .gte('entry_date', monthStart),
      supabase
        .from('finance_journal_import_rules')
        .select('*, category:finance_journal_categories(id, name, kind)')
        .order('keyword'),
      // 逐行结余需要全量未作废历史按时间正序累计，不受展示上限影响
      supabase
        .from('finance_journal_entries')
        .select('id, account_id, entry_date, created_at, kind, amount_original, voided_at')
        .order('entry_date')
        .order('created_at'),
      // 报销人/成员下拉候选（已审核成员）
      supabase
        .from('profiles')
        .select('id, chinese_name, full_name, email')
        .eq('approval_status', 'approved')
        .order('chinese_name'),
    ])

  const accounts = (accountsResult.data ?? []) as FinanceJournalAccount[]
  const categories = (categoriesResult.data ?? []) as FinanceJournalCategory[]
  const entries = (entriesResult.data ?? []) as FinanceJournalEntry[]
  const balances = (balancesResult.data ?? []) as FinanceJournalAccountBalance[]
  const rules = (rulesResult.data ?? []) as FinanceJournalImportRule[]

  const monthFlowMap = new Map<string, { income: number; expense: number }>()
  for (const row of monthFlowsResult.data ?? []) {
    const flow = monthFlowMap.get(row.account_id) ?? { income: 0, expense: 0 }
    if (row.kind === 'income') flow.income += Number(row.amount_original)
    else flow.expense += Number(row.amount_original)
    monthFlowMap.set(row.account_id, flow)
  }
  const monthFlows = [...monthFlowMap.entries()].map(([account_id, flow]) => ({
    account_id,
    income: flow.income,
    expense: flow.expense,
  }))

  // 逐行结余：期初 + 按日期正序累计（原币口径，与余额视图同式，排除作废）
  const runningBalances: Record<string, number> = {}
  {
    const accBalance = new Map<string, number>(
      accounts.map((account) => [account.id, Number(account.initial_balance)]),
    )
    for (const row of historyResult.data ?? []) {
      if (row.voided_at) continue
      const next =
        (accBalance.get(row.account_id) ?? 0) +
        (row.kind === 'income' ? Number(row.amount_original) : -Number(row.amount_original))
      accBalance.set(row.account_id, next)
      runningBalances[row.id] = next
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">财务日记账</h1>
        <p className="text-sm text-muted-foreground">
          按银行账户登记日常收入与支出，自动统计各账户余额与钱花在哪里。
        </p>
      </div>
      <JournalManager
        entries={entries}
        accounts={accounts}
        categories={categories}
        balances={balances}
        monthFlows={monthFlows}
        rules={rules}
        runningBalances={runningBalances}
        members={
          (membersResult.data ?? []) as Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'>[]
        }
      />
    </div>
  )
}
