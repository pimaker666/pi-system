import { JournalManager } from '@/components/finance/journal-manager'
import { requireFinanceView } from '@/lib/auth'
import { chinaToday } from '@/lib/daily-order-costs-server'
import { fetchAllJournalRows, fetchJournalData } from '@/lib/finance-journal-server'
import { journalMonthRange } from '@/lib/finance-journal'
import { createClient } from '@/lib/supabase/server'
import type {
  FinanceJournalAccountBalance,
  FinanceJournalCategory,
  FinanceJournalImportRule,
  Profile,
} from '@/types'

export default async function FinanceJournalPage() {
  await requireFinanceView()
  const supabase = await createClient()
  const month = journalMonthRange(chinaToday().slice(0, 7))!

  let data
  try {
    data = await Promise.all([
      fetchJournalData(supabase),
      fetchAllJournalRows<FinanceJournalCategory>((from, to) => supabase
        .from('finance_journal_categories').select('*').order('kind').order('sort_order').order('id').range(from, to)),
      fetchAllJournalRows<FinanceJournalAccountBalance>((from, to) => supabase
        .from('finance_journal_account_balances').select('*').order('account_id').range(from, to)),
      fetchAllJournalRows<FinanceJournalImportRule>((from, to) => supabase
        .from('finance_journal_import_rules').select('*, category:finance_journal_categories(id, name, kind)')
        .order('keyword').order('id').range(from, to)),
      fetchAllJournalRows<Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'>>((from, to) => supabase
        .from('profiles').select('id, chinese_name, full_name, email')
        .eq('status', 'approved').order('chinese_name').order('id').range(from, to)),
    ])
  } catch {
    return <div role="alert" className="rounded-lg border p-6">日记账读取失败，请刷新重试；未显示不完整的余额或流水。</div>
  }

  const [{ accounts, entries, runningBalances }, categories, balances, rules, members] = data
  const monthFlowMap = new Map<string, { income: number; expense: number }>()
  for (const row of entries) {
    if (row.voided_at || row.entry_date < month.from || row.entry_date > month.to) continue
    const flow = monthFlowMap.get(row.account_id) ?? { income: 0, expense: 0 }
    if (row.kind === 'income') flow.income += Number(row.amount_original)
    else flow.expense += Number(row.amount_original)
    monthFlowMap.set(row.account_id, flow)
  }
  const monthFlows = [...monthFlowMap.entries()].map(([account_id, flow]) => ({ account_id, ...flow }))

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
        members={members}
      />
    </div>
  )
}
