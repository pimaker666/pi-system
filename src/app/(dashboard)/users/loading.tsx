import { cn } from '@/lib/utils'

function Bar({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />
}

const TABS = ['a', 'b', 'c', 'd']
const TABLE_ROWS = ['1', '2', '3', '4', '5', '6', '7', '8']
const TABLE_COLUMNS = ['1', '2', '3', '4', '5', '6', '7', '8']

export default function UsersLoading() {
  return (
    <div className="space-y-6" role="status" aria-live="polite">
      <span className="sr-only">页面加载中</span>
      <div className="space-y-2">
        <Bar className="h-8 w-32" />
        <Bar className="h-4 w-full max-w-2xl" />
      </div>

      <div className="flex flex-wrap gap-2 border-b pb-4">
        {TABS.map((key, index) => (
          <Bar key={key} className={cn('h-9 w-24 rounded-md', index === 0 && 'bg-primary/20')} />
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
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
