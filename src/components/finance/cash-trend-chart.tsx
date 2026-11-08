import { getBusinessDateKey } from '@/lib/business-orders'
import { formatCny } from '@/lib/finance'

export interface CashTrendPoint {
  month: string
  income: number
  expense: number
}

const WIDTH = 640
const HEIGHT = 218
const LEFT = 48
const RIGHT = 620
const BASELINE = 184
const TOP = 36

function niceCeiling(value: number) {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

function formatWan(value: number) {
  const wan = value / 10000
  return `${wan >= 100 ? Math.round(wan) : wan.toFixed(wan >= 10 ? 1 : 2)}万`
}

export function CashTrendChart({ points }: { points: CashTrendPoint[] }) {
  const rows = points.length > 0 ? points : []
  const peak = Math.max(0, ...rows.flatMap((row) => [row.income, row.expense]))
  const ceiling = niceCeiling(peak)
  const total = rows.reduce((sum, row) => sum + row.income + row.expense, 0)
  const span = Math.max(1, RIGHT - LEFT)
  const groupWidth = span / Math.max(1, rows.length)
  const barWidth = Math.min(24, Math.max(10, groupWidth / 3.2))
  const currentMonth = getBusinessDateKey().slice(0, 7)
  const scale = (value: number) => (value / ceiling) * (BASELINE - TOP)

  if (rows.length === 0 || total === 0) {
    return (
      <div className="flex h-[218px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        近 {rows.length || 6} 个月还没有现金收支记录
      </div>
    )
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-[218px] w-full"
        role="img"
        aria-label="近几个月现金收支柱状图"
      >
        <title>现金收支趋势</title>
        {[0, 0.5, 1].map((ratio) => {
          const y = BASELINE - ratio * (BASELINE - TOP)
          return (
            <g key={ratio}>
              <line x1={LEFT} y1={y} x2={RIGHT} y2={y} stroke="#eef2f8" strokeWidth={1} />
              <text x={LEFT - 8} y={y + 3} textAnchor="end" fill="#94a3b8" fontSize={10}>
                {ratio === 0 ? '0' : formatWan(ceiling * ratio)}
              </text>
            </g>
          )
        })}
        {rows.map((row, index) => {
          const groupX = LEFT + index * groupWidth
          const centerX = groupX + groupWidth / 2
          const incomeX = centerX - barWidth - 1
          const expenseX = centerX + 1
          const incomeHeight = scale(row.income)
          const expenseHeight = scale(row.expense)
          const shortMonth = row.month.slice(5)
          const sameYear = row.month.slice(0, 4) === currentMonth.slice(0, 4)
          const label = row.month === currentMonth ? '本月' : `${Number(shortMonth)}月`
          return (
            <g key={row.month}>
              <rect
                x={incomeX}
                y={BASELINE - incomeHeight}
                width={barWidth}
                height={Math.max(incomeHeight, row.income > 0 ? 2 : 0)}
                rx={3}
                fill="#3b82f6"
              >
                <title>{`${row.month} 收入 ${formatCny(row.income)}`}</title>
              </rect>
              <rect
                x={expenseX}
                y={BASELINE - expenseHeight}
                width={barWidth}
                height={Math.max(expenseHeight, row.expense > 0 ? 2 : 0)}
                rx={3}
                fill="#fbbf24"
              >
                <title>{`${row.month} 支出 ${formatCny(row.expense)}`}</title>
              </rect>
              <text x={centerX} y={BASELINE + 18} textAnchor="middle" fill="#94a3b8" fontSize={10}>
                {sameYear ? label : row.month.replace('-', '/')}
              </text>
            </g>
          )
        })}
        <line
          x1={LEFT}
          y1={TOP - 8}
          x2={RIGHT}
          y2={TOP - 8}
          stroke="#e2e8f0"
          strokeDasharray="3 4"
        />
        <text x={RIGHT} y={TOP - 12} textAnchor="end" fill="#94a3b8" fontSize={9}>
          峰值 {formatWan(peak)}
        </text>
      </svg>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>金额单位：万元；本月为进行中数据，随记账实时更新</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <i className="h-2 w-2 rounded-sm bg-blue-500" aria-hidden />
            收入
          </span>
          <span className="flex items-center gap-1">
            <i className="h-2 w-2 rounded-sm bg-amber-400" aria-hidden />
            支出
          </span>
        </span>
      </div>
    </div>
  )
}
