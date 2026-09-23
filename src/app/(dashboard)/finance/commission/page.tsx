import { CommissionManager } from '@/components/finance/commission-manager'
import { requireApproved } from '@/lib/auth'
import { fetchBusinessOrderCommissions } from '@/lib/business-order-commissions-server'
import { parseBusinessOrderCommissionFilters } from '@/lib/business-order-commission'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'

export default async function FinanceCommissionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const profile = await requireApproved()
  const parsedFilters = parseBusinessOrderCommissionFilters(await searchParams)
  const isSalesperson = profile.role === 'sales' || profile.role === 'supervisor'
  const filters = isSalesperson
    ? { ...parsedFilters, salespeople: [profile.id] }
    : parsedFilters
  const supabase = await createClient()

  const [options, commissions] = await Promise.all([
    fetchDailyOrderOptions(supabase),
    fetchBusinessOrderCommissions(supabase, filters, filters.page),
  ])

  const canManageCategoryRates = profile.role === 'admin' || profile.role === 'finance'
  const isAdmin = profile.role === 'admin'

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">业务提成</h1>
        <p className="text-sm text-muted-foreground">
          业务员为订单关联客户后，订单即进入本页；按产品行计算产品提成、按订单计算运费利润与运费提成。
        </p>
      </div>
      <CommissionManager
        rows={commissions.rows}
        totalCount={commissions.totalCount}
        filters={filters}
        categoryRates={commissions.categoryRates}
        customerTags={commissions.customerTags}
        customOrderRates={commissions.customOrderRates}
        canManageCategoryRates={canManageCategoryRates}
        isAdmin={isAdmin}
        options={options}
        actor={profile}
      />
    </div>
  )
}
