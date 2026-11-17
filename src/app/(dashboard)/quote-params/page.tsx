import { requireProfile } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { QuoteParamsManager } from '@/components/quote/quote-params-manager'
import { reviveInfTiers, type QuoteOverrides } from '@/lib/quote/data'

export default async function QuoteParamsPage() {
  const profile = await requireProfile()

  if (profile.role !== 'admin') {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">报价参数</h1>
        <p className="text-sm text-muted-foreground">仅管理员可访问此页面。</p>
      </div>
    )
  }

  const supabase = await createClient()
  const { data } = await supabase.from('quote_params').select('category, overrides')

  const saved: QuoteOverrides = {}
  for (const row of data ?? []) {
    if (row.category === 'globals') Object.assign(saved, reviveInfTiers(row.overrides))
    else (saved as Record<string, unknown>)[row.category] = reviveInfTiers(row.overrides)
  }

  return <QuoteParamsManager saved={saved} />
}
