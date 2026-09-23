import { formatDailyMoney } from '@/lib/daily-orders'
import type { BusinessOrderCommissionRow } from '@/types'

interface CommissionSummaryTotal {
  salespersonName: string
  period: string
  productAmount: number
  freightAmount: number
  missingRateCount: number
}

function summarize(rows: BusinessOrderCommissionRow[]) {
  const totals = new Map<string, CommissionSummaryTotal>()
  for (const row of rows) {
    if (!row.clearance_period) continue
    const key = `${row.salesperson_name}\u0000${row.clearance_period}`
    const total = totals.get(key) ?? {
      salespersonName: row.salesperson_name,
      period: row.clearance_period,
      productAmount: 0,
      freightAmount: 0,
      missingRateCount: 0,
    }
    const rate = row.currency === 'USD' ? row.settlement_exchange_rate_to_cny : 1
    if (rate == null) {
      total.missingRateCount += 1
    } else {
      total.productAmount += row.product_commission_amount * rate
      if (row.is_order_lead_row) total.freightAmount += row.freight_commission_amount * rate
    }
    totals.set(key, total)
  }
  return [...totals.values()].sort(
    (left, right) => right.period.localeCompare(left.period) || left.salespersonName.localeCompare(right.salespersonName, 'zh-CN'),
  )
}

export function CommissionSummary({
  rows,
  showSalesperson = true,
}: {
  rows: BusinessOrderCommissionRow[]
  showSalesperson?: boolean
}) {
  const totals = summarize(rows)

  return (
    <section className="space-y-3 rounded-md border bg-card p-4">
      <div>
        <h2 className="font-semibold">已结清提成总览</h2>
        <p className="text-sm text-muted-foreground">按结清归属月统计产品提成、运费提成与总提成。</p>
      </div>
      {totals.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">暂无已结清提成</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-sm">
            <thead className="border-b text-left text-muted-foreground">
              <tr>
                {showSalesperson && <th className="px-3 py-2 font-medium">业务员</th>}
                <th className="px-3 py-2 font-medium">结清月份</th>
                <th className="px-3 py-2 text-right font-medium">产品提成</th>
                <th className="px-3 py-2 text-right font-medium">运费提成</th>
                <th className="px-3 py-2 text-right font-medium">总提成</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((total) => (
                <tr key={`${total.salespersonName}-${total.period}`} className="border-b last:border-0">
                  {showSalesperson && <td className="px-3 py-2">{total.salespersonName}</td>}
                  <td className="px-3 py-2 tabular-nums">{total.period}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatDailyMoney(total.productAmount, 'CNY')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatDailyMoney(total.freightAmount, 'CNY')}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {formatDailyMoney(total.productAmount + total.freightAmount, 'CNY')}
                    {total.missingRateCount > 0 && (
                      <span className="ml-2 text-xs font-normal text-amber-600">{total.missingRateCount} 行美元订单未计入</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
