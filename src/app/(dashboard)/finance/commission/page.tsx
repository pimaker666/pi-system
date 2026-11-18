import Link from 'next/link'
import { redirect } from 'next/navigation'
import { CommissionClearanceDetails } from '@/components/finance/commission-clearance-details'
import { CommissionManager } from '@/components/finance/commission-manager'
import { OperatorCommissionManager } from '@/components/finance/operator-commission-manager'
import { hasCurrentPermission, requireApproved } from '@/lib/auth'
import {
  fetchBusinessOrderCommissionClearanceDetails,
  fetchBusinessOrderCommissions,
} from '@/lib/business-order-commissions-server'
import { parseBusinessOrderCommissionFilters } from '@/lib/business-order-commission'
import { fetchCommissionRules } from '@/lib/commission-rules-server'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import {
  fetchOperatorCandidates,
  fetchOperatorCommission,
  fetchShopOperatorRules,
} from '@/lib/operator-commission-server'
import { createClient } from '@/lib/supabase/server'
import { cn } from '@/lib/utils'

function scalar(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw
}

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
  // 运营只看自己的「我的提成」，不进入财务提成页。
  if (profile.role === 'operations') redirect('/finance/my-commission')

  const view = scalar(search.view) === 'operator' ? 'operator' : 'business'
  const parsedFilters = parseBusinessOrderCommissionFilters(search)
  const isSalesperson = profile.role === 'sales' || profile.role === 'supervisor'
  const baseFilters = isSalesperson
    ? { ...parsedFilters, salespeople: [profile.id] }
    : parsedFilters
  const filters = {
    ...baseFilters,
    shops: baseFilters.shops.filter((id) => id !== '__all__'),
  }
  const supabase = await createClient()

  const canManageCategoryRates = profile.role === 'admin' || profile.role === 'finance'
  const tab = (
    <div className="inline-flex rounded-full border bg-card p-1 text-sm shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
      <Link
        href="/finance/commission"
        className={cn(
          'rounded-full px-4 py-1.5 transition',
          view === 'business' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        业务提成
      </Link>
      <Link
        href="/finance/commission?view=operator"
        className={cn(
          'rounded-full px-4 py-1.5 transition',
          view === 'operator' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        运营提成
      </Link>
    </div>
  )

  if (view === 'operator') {
    const operatorFilter = scalar(search.operatorId) || null
    const [options, operatorResult, shopRules, operators, operatorRules, businessRules] =
      await Promise.all([
        fetchDailyOrderOptions(supabase),
        fetchOperatorCommission(supabase, filters, { operatorId: operatorFilter }),
        fetchShopOperatorRules(supabase),
        fetchOperatorCandidates(supabase),
        fetchCommissionRules(supabase, 'operator'),
        fetchCommissionRules(supabase, 'business'),
      ])
    // 运营规则也支持按客户标记命中，标记选项沿用业务线的标记规则。
    const tagOptions = businessRules
      .filter((rule) => rule.legacy_source === 'tag' && rule.tag_color)
      .map((rule) => ({ color: rule.tag_color as string, label: rule.name }))
    return (
      <div className="space-y-6">
        <section className="flex flex-wrap items-start justify-between gap-4 rounded-xl border bg-card p-5 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
          <div className="min-w-0 space-y-3">
            <div className="inline-flex rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
              业绩与提成
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">运营提成</h1>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
                运营提成按产品实收计算，归属可来自店铺规则（支持多人按份额分摊）或订单级指定；订单指定后不再叠加店铺规则。业务结清与运营结清相互独立。
              </p>
            </div>
            {tab}
          </div>
        </section>
        <OperatorCommissionManager
          rows={operatorResult.rows}
          totalCount={operatorResult.totalCount}
          filters={filters}
          shopRules={shopRules}
          operators={operators}
          shops={options.shops.map((shop) => ({ id: shop.id, name: shop.name }))}
          actorRole={profile.role}
          actorId={profile.id}
          canManageRules={canManageCategoryRates}
          canManageClearance={canManageCategoryRates}
          commissionRules={operatorRules}
          tagOptions={tagOptions}
        />
      </div>
    )
  }

  const [options, commissions, clearanceDetails] = await Promise.all([
    fetchDailyOrderOptions(supabase),
    fetchBusinessOrderCommissions(supabase, filters, filters.page),
    canManageCategoryRates ? fetchBusinessOrderCommissionClearanceDetails(supabase) : Promise.resolve([]),
  ])

  const isAdmin = profile.role === 'admin'

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-start justify-between gap-4 rounded-xl border bg-card p-5 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
        <div className="min-w-0 space-y-3">
          <div className="inline-flex rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
            业绩与提成
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">业务提成</h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              已收齐且已发货的产品行自动进入本页；业务确认或财务直接结清后即视为已结清，全部结清的订单会自动移入“已结清订单”。未关联客户的订单保留展示，补充客户后即可按产品行计算提成。
            </p>
          </div>
          {tab}
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
        commissionRules={commissions.commissionRules}
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
