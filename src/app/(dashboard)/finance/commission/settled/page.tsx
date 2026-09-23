import { CommissionManager } from '@/components/finance/commission-manager'
import { requireFinanceAccess } from '@/lib/auth'
import { fetchBusinessOrderCommissions } from '@/lib/business-order-commissions-server'
import { parseBusinessOrderCommissionFilters } from '@/lib/business-order-commission'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'

export default async function SettledCommissionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const profile = await requireFinanceAccess()
  const filters = parseBusinessOrderCommissionFilters(await searchParams)
  const supabase = await createClient()
  const [options, commissions] = await Promise.all([
    fetchDailyOrderOptions(supabase),
    fetchBusinessOrderCommissions(supabase, filters, filters.page, undefined, 'settled'),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">已结清订单</h1>
        <p className="text-sm text-muted-foreground">所有产品行均已确认结清的订单归档于此，仅供查询。</p>
      </div>
      <CommissionManager
        rows={commissions.rows}
        totalCount={commissions.totalCount}
        filters={filters}
        categoryRates={commissions.categoryRates}
        customerTags={commissions.customerTags}
        customOrderRates={commissions.customOrderRates}
        canManageCategoryRates={false}
        isAdmin={false}
        actor={profile}
        readOnly
        options={options}
      />
    </div>
  )
}
