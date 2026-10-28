import { JournalOverview } from '@/components/finance/journal-overview'
import { requireFinanceView } from '@/lib/auth'
import { fetchJournalData } from '@/lib/finance-journal-server'
import { createClient } from '@/lib/supabase/server'

export default async function FinanceJournalOverviewPage() {
  await requireFinanceView()
  let data
  try {
    data = await fetchJournalData(await createClient())
  } catch {
    return <div role="alert" className="rounded-lg border p-6">日记账读取失败，请刷新重试。</div>
  }

  return (
    <div className="space-y-6">
      <JournalOverview entries={data.entries} accounts={data.accounts} />
    </div>
  )
}
