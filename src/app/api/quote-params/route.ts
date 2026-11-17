import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { reviveInfTiers, type CategoryId, type QuoteOverrides } from '@/lib/quote/data'

export async function GET() {
  const supabase = await createClient()
  const { data, error } = await supabase.from('quote_params').select('category, overrides')
  if (error) return NextResponse.json({ overrides: {} }, { status: 200 })

  const overrides: QuoteOverrides = {}
  for (const row of data ?? []) {
    if (row.category === 'globals') Object.assign(overrides, reviveInfTiers(row.overrides))
    else overrides[row.category as CategoryId] = reviveInfTiers(row.overrides)
  }
  return NextResponse.json({ overrides })
}
