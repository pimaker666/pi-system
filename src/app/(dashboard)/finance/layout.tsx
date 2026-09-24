import { FinanceNav } from '@/components/finance/finance-nav'
import { requireApproved } from '@/lib/auth'
import { fetchBusinessOrderCommissions } from '@/lib/business-order-commissions-server'
import { parseBusinessOrderCommissionFilters } from '@/lib/business-order-commission'
import { createClient } from '@/lib/supabase/server'

export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireApproved()
  const isSalesperson = profile.role === 'sales' || profile.role === 'supervisor'
  const supabase = await createClient()
  const commissionAttentionCount = isSalesperson
    ? (await fetchBusinessOrderCommissions(
      supabase,
      { ...parseBusinessOrderCommissionFilters({}), salespeople: [profile.id] },
      1,
      1000,
    )).rows.filter((row) => row.clearance_status === 'pending').length
    : 0

  return (
    <div>
      <FinanceNav role={profile.role} commissionAttentionCount={commissionAttentionCount} />
      {children}
    </div>
  )
}
