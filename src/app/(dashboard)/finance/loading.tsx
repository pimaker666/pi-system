import { cn } from '@/lib/utils'

function Bar({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />
}

const SUMMARY_CARDS = ['a', 'b', 'c', 'd']
const TABLE_ROWS = ['1', '2', '3', '4', '5', '6', '7', '8']
const TABLE_COLUMNS = ['1', '2', '3', '4', '5']

export default function FinanceLoading() {
  return (
    <div className="space-y-6" role="status" aria-live="polite">
      <span className="sr-only">页面加载中</span>
      <div className="space-y-2">
        <Bar className="h-8 w-40" />
        <Bar className="h-4 w-full max-w-xl" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {SUMMARY_CARDS.map((key) => (
          <div key={key} className="rounded-xl border bg-card p-4 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
            <div className="flex items-center justify-between">
              <Bar className="h-4 w-20" />
              <Bar className="h-4 w-4 rounded-full" />
            </div>
            <Bar className="mt-4 h-7 w-28" />
          </div>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {SUMMARY_CARDS.slice(0, 2).map((key) => (
          <div key={key} className="rounded-xl border bg-card p-4 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
            <Bar className="h-4 w-24" />
            <Bar className="mt-4 h-7 w-32" />
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
        <div className="border-b px-4 py-3">
          <Bar className="h-4 w-28" />
        </div>
        <div className="flex items-center gap-4 border-b bg-muted/40 px-4 py-3">
          {TABLE_COLUMNS.map((key) => (
            <Bar key={key} className="h-3 flex-1" />
          ))}
        </div>
        {TABLE_ROWS.map((row) => (
          <div key={row} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
            {TABLE_COLUMNS.map((column) => (
              <Bar key={column} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
