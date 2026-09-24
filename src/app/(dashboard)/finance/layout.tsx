import { FinanceNav } from '@/components/finance/finance-nav'
import { requireApproved } from '@/lib/auth'
import { fetchBusinessOrderCommissionClearanceAttentionCount } from '@/lib/business-order-commissions-server'
import { createClient } from '@/lib/supabase/server'

export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireApproved()
  const isSalesperson = profile.role === 'sales' || profile.role === 'supervisor'
  const supabase = await createClient()
  const commissionAttentionCount = await fetchBusinessOrderCommissionClearanceAttentionCount(
    supabase,
    isSalesperson ? ['pending'] : ['pending', 'rejected'],
  )

  return (
    <div>
      <FinanceNav role={profile.role} commissionAttentionCount={commissionAttentionCount} />
      {children}
    </div>
  )
}
