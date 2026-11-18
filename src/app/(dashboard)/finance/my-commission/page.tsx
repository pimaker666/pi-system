import { redirect } from 'next/navigation'
import { CommissionManager } from '@/components/finance/commission-manager'
import { CommissionSummary } from '@/components/finance/commission-summary'
import { OperatorCommissionManager } from '@/components/finance/operator-commission-manager'
import { requireApproved } from '@/lib/auth'
import { fetchBusinessOrderCommissions } from '@/lib/business-order-commissions-server'
import { parseBusinessOrderCommissionFilters } from '@/lib/business-order-commission'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import {
  fetchOperatorCandidates,
  fetchOperatorCommission,
  fetchShopOperatorRules,
} from '@/lib/operator-commission-server'
import { createClient } from '@/lib/supabase/server'

export default async function MyCommissionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const profile = await requireApproved()
  const search = await searchParams

  if (profile.role === 'operations') {
    const parsed = parseBusinessOrderCommissionFilters(search)
    const filters = { ...parsed, shops: parsed.shops.filter((id) => id !== '__all__') }
    const supabase = await createClient()
    const [options, pendingResult, settledResult, operators] = await Promise.all([
      fetchDailyOrderOptions(supabase),
      fetchOperatorCommission(supabase, filters, { operatorId: profile.id, pendingOnly: true }),
      fetchOperatorCommission(supabase, filters, {
        operatorId: profile.id,
        scope: 'settled',
        includeSummary: true,
      }),
      fetchOperatorCandidates(supabase),
    ])
    // 运营只需要本人身份与候选名单里的名字，规则数据不展示。
    const shopRules = await fetchShopOperatorRules(supabase)

    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">我的提成</h1>
          <p className="text-sm text-muted-foreground">
            按订单产品实收 × 提点 × 本人份额计算运营提成；确认后进入已结清总览。
          </p>
        </div>

        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">待确认运营提成</h2>
            <p className="text-sm text-muted-foreground">财务提交结清后需要本人确认；有异议可驳回并说明原因。</p>
          </div>
          <OperatorCommissionManager
            rows={pendingResult.rows}
            totalCount={pendingResult.totalCount}
            filters={filters}
            shopRules={shopRules}
            operators={operators}
            shops={options.shops.map((shop) => ({ id: shop.id, name: shop.name }))}
            actorRole={profile.role}
            actorId={profile.id}
            canManageRules={false}
            canManageClearance={false}
            canConfirmSelf
          />
        </section>

        <OperatorCommissionManager
          rows={settledResult.rows}
          totalCount={settledResult.totalCount}
          filters={filters}
          summary={settledResult.summary}
          shopRules={shopRules}
          operators={operators}
          shops={options.shops.map((shop) => ({ id: shop.id, name: shop.name }))}
          actorRole={profile.role}
          actorId={profile.id}
          canManageRules={false}
          canManageClearance={false}
          readOnly
          showSummary
          showFilters={false}
        />
      </div>
    )
  }

  if (profile.role !== 'sales' && profile.role !== 'supervisor') redirect('/dashboard')

  const parsedFilters = parseBusinessOrderCommissionFilters(search)
  const filters = { ...parsedFilters, salespeople: [profile.id] }
  const supabase = await createClient()
  const [options, commissions] = await Promise.all([
    fetchDailyOrderOptions(supabase),
    fetchBusinessOrderCommissions(supabase, filters, filters.page, undefined, 'settled', true),
  ])
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">我的提成</h1>
        <p className="text-sm text-muted-foreground">查看本人已确认结清的历史订单及按结清归属月汇总的提成。</p>
      </div>

      <CommissionSummary totals={commissions.summary ?? []} showSalesperson={false} />

      <CommissionManager
        rows={commissions.rows}
        totalCount={commissions.totalCount}
        filters={filters}
        categoryRates={commissions.categoryRates}
        customerTags={commissions.customerTags}
        customOrderRates={commissions.customOrderRates}
        commissionRules={commissions.commissionRules}
        defaultFreightCommissionRate={commissions.defaultFreightCommissionRate}
        canManageCategoryRates={false}
        canManageExchangeRate={false}
        isAdmin={false}
        actor={profile}
        readOnly
        options={options}
      />
    </div>
  )
}
