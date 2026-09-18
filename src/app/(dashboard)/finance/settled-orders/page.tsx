import { SettledOrderTable } from '@/components/finance/settled-order-table'
import { requireFinanceAccess } from '@/lib/auth'
import {
  fetchSettledOrderRows,
  fetchSettledPeriods,
  parseSettledOrderFilters,
} from '@/lib/business-order-settlements-server'
import { createClient } from '@/lib/supabase/server'

export default async function FinanceSettledOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireFinanceAccess()
  const filters = parseSettledOrderFilters(await searchParams)
  const supabase = await createClient()

  const [periods, rows] = await Promise.all([
    fetchSettledPeriods(supabase),
    fetchSettledOrderRows(supabase, filters),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">已结算订单</h1>
        <p className="text-sm text-muted-foreground">
          在“订单成本”页结算的产品行归档到此处，按结算年月筛选；取消结算后产品行回到订单成本页。
        </p>
      </div>
      <SettledOrderTable rows={rows} periods={periods} filters={filters} />
    </div>
  )
}
