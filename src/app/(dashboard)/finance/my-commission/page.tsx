import { redirect } from 'next/navigation'
import { CommissionManager } from '@/components/finance/commission-manager'
import { CommissionSummary } from '@/components/finance/commission-summary'
import { requireApproved } from '@/lib/auth'
import { fetchBusinessOrderCommissions } from '@/lib/business-order-commissions-server'
import { parseBusinessOrderCommissionFilters } from '@/lib/business-order-commission'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'

export default async function MyCommissionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const profile = await requireApproved()
  if (profile.role !== 'sales' && profile.role !== 'supervisor') redirect('/dashboard')

  const parsedFilters = parseBusinessOrderCommissionFilters(await searchParams)
  const filters = { ...parsedFilters, salespeople: [profile.id], page: 1 }
  const supabase = await createClient()
  const [options, commissions] = await Promise.all([
    fetchDailyOrderOptions(supabase),
    fetchBusinessOrderCommissions(supabase, filters, 1, 1000, 'settled'),
  ])
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">我的提成</h1>
        <p className="text-sm text-muted-foreground">查看本人已确认结清的历史订单及按结清归属月汇总的提成。</p>
      </div>

      <CommissionSummary rows={commissions.rows} showSalesperson={false} />

      <CommissionManager
        rows={commissions.rows}
        totalCount={commissions.totalCount}
        filters={filters}
        categoryRates={commissions.categoryRates}
        customerTags={commissions.customerTags}
        customOrderRates={commissions.customOrderRates}
        defaultFreightCommissionRate={commissions.defaultFreightCommissionRate}
        canManageCategoryRates={false}
        isAdmin={false}
        actor={profile}
        readOnly
        options={options}
      />
    </div>
  )
}
