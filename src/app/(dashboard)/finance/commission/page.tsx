import { CommissionClearanceDetails } from '@/components/finance/commission-clearance-details'
import { CommissionManager } from '@/components/finance/commission-manager'
import { hasCurrentPermission, requireApproved } from '@/lib/auth'
import {
  fetchBusinessOrderCommissionClearanceDetails,
  fetchBusinessOrderCommissions,
} from '@/lib/business-order-commissions-server'
import { parseBusinessOrderCommissionFilters } from '@/lib/business-order-commission'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'

export default async function FinanceCommissionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [profile, canManageExchangeRate, search] = await Promise.all([
    requireApproved(),
    hasCurrentPermission('finance.exchange_rate'),
    searchParams,
  ])
  const parsedFilters = parseBusinessOrderCommissionFilters(search)
  const isSalesperson = profile.role === 'sales' || profile.role === 'supervisor'
  const filters = isSalesperson
    ? { ...parsedFilters, salespeople: [profile.id] }
    : parsedFilters
  const supabase = await createClient()

  const canManageCategoryRates = profile.role === 'admin' || profile.role === 'finance'
  const [options, commissions, clearanceDetails] = await Promise.all([
    fetchDailyOrderOptions(supabase),
    fetchBusinessOrderCommissions(supabase, filters, filters.page),
    canManageCategoryRates ? fetchBusinessOrderCommissionClearanceDetails(supabase) : Promise.resolve([]),
  ])

  const isAdmin = profile.role === 'admin'

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-start justify-between gap-4 rounded-xl border bg-card p-5 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
        <div className="min-w-0 space-y-2">
          <div className="inline-flex rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
            业绩与提成
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">业务提成</h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              已收齐且已发货的产品行自动进入本页；全部确认结清的订单会自动移入“已结清订单”。未关联客户的订单保留展示，补充客户后即可按产品行计算提成。
            </p>
          </div>
        </div>
        {canManageCategoryRates && <CommissionClearanceDetails rows={clearanceDetails} />}
      </section>
      <CommissionManager
        rows={commissions.rows}
        totalCount={commissions.totalCount}
        filters={filters}
        categoryRates={commissions.categoryRates}
        customerTags={commissions.customerTags}
        customOrderRates={commissions.customOrderRates}
        defaultFreightCommissionRate={commissions.defaultFreightCommissionRate}
        canManageCategoryRates={canManageCategoryRates}
        canManageExchangeRate={canManageExchangeRate}
        isAdmin={isAdmin}
        options={options}
        actor={profile}
      />
    </div>
  )
}
