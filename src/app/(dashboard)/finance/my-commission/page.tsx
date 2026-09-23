import { redirect } from 'next/navigation'
import { CommissionManager } from '@/components/finance/commission-manager'
import { requireApproved } from '@/lib/auth'
import { fetchBusinessOrderCommissions } from '@/lib/business-order-commissions-server'
import { parseBusinessOrderCommissionFilters } from '@/lib/business-order-commission'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { formatDailyMoney } from '@/lib/daily-orders'
import { createClient } from '@/lib/supabase/server'
import type { BusinessOrderCommissionRow } from '@/types'

function monthlyTotals(rows: BusinessOrderCommissionRow[]) {
  const totals = new Map<string, { amount: number; missingRateCount: number }>()
  for (const row of rows) {
    const period = row.clearance_period
    if (!period) continue
    const rate = row.currency === 'USD' ? row.settlement_exchange_rate_to_cny : 1
    const total = totals.get(period) ?? { amount: 0, missingRateCount: 0 }
    if (rate == null) {
      total.missingRateCount += 1
    } else {
      total.amount += row.product_commission_amount * rate
      if (row.is_order_lead_row) total.amount += row.freight_commission_amount * rate
    }
    totals.set(period, total)
  }
  return [...totals.entries()].sort(([left], [right]) => right.localeCompare(left))
}

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
  const totals = monthlyTotals(commissions.rows)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">我的提成</h1>
        <p className="text-sm text-muted-foreground">查看本人已确认结清的历史订单及按结清归属月汇总的提成。</p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {totals.length === 0 ? (
          <div className="rounded-md border px-4 py-5 text-sm text-muted-foreground">暂无已结清提成</div>
        ) : (
          totals.map(([period, total]) => (
            <div key={period} className="rounded-md border bg-card p-4">
              <div className="text-sm text-muted-foreground">{period}</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">{formatDailyMoney(total.amount, 'CNY')}</div>
              {total.missingRateCount > 0 && (
                <div className="mt-1 text-xs text-amber-600">{total.missingRateCount} 行美元订单待补汇率，未计入</div>
              )}
            </div>
          ))
        )}
      </section>

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
