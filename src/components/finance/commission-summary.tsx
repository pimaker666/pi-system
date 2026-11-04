import {
  formatCommissionAmount,
  type CommissionSummaryTotal,
} from '@/lib/business-order-commission'

export function CommissionSummary({
  totals,
  showSalesperson = true,
}: {
  /** 服务端按「业务员 + 结清归属月」预先汇总好的行，组件只负责渲染。 */
  totals: CommissionSummaryTotal[]
  showSalesperson?: boolean
}) {
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
                  <td className="px-3 py-2 text-right tabular-nums">{formatCommissionAmount(total.productAmount)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCommissionAmount(total.freightAmount)}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {formatCommissionAmount(total.productAmount + total.freightAmount)}
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
