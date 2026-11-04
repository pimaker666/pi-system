import { FinanceNav } from '@/components/finance/finance-nav'
import { hasFinanceViewFor, requireApproved } from '@/lib/auth'
import { fetchCommissionAttentionCount } from '@/lib/business-order-commissions-server'
import { createClient } from '@/lib/supabase/server'

export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireApproved()
  const isSalesperson = profile.role === 'sales' || profile.role === 'supervisor'
  const supabase = await createClient()
  const commissionAttentionCount = isSalesperson
    ? await fetchCommissionAttentionCount(supabase, profile.id)
    : 0
  const canViewFinance = await hasFinanceViewFor(profile)

  return (
    <div>
      <FinanceNav
        role={profile.role}
        commissionAttentionCount={commissionAttentionCount}
        canManageFinance={canViewFinance}
      />
      {children}
    </div>
  )
}
