import { cn } from '@/lib/utils'

function Bar({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />
}

/**
 * 路由级 loading 骨架。列表页用默认的表格形态，总览页传 `variant="cards"`。
 */
export function PageSkeleton({
  columns = 6,
  rows = 8,
  variant = 'table',
  className,
}: {
  columns?: number
  rows?: number
  variant?: 'table' | 'cards'
  className?: string
}) {
  const columnKeys = Array.from({ length: columns }, (_, index) => String(index))
  const rowKeys = Array.from({ length: rows }, (_, index) => String(index))

  return (
    <div className={cn('space-y-6', className)} role="status" aria-live="polite">
      <span className="sr-only">页面加载中</span>
      <div className="space-y-2">
        <Bar className="h-8 w-40" />
        <Bar className="h-4 w-full max-w-xl" />
      </div>

      {variant === 'cards' ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {columnKeys.slice(0, 4).map((key) => (
            <div key={key} className="rounded-xl border bg-card p-4 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
              <Bar className="h-4 w-20" />
              <Bar className="mt-4 h-7 w-24" />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-3 rounded-xl border bg-card p-4 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
          <Bar className="h-10 flex-1" />
          <Bar className="h-10 w-32" />
          <Bar className="h-10 w-32" />
          <Bar className="h-10 w-24" />
        </div>
      )}

      <div className="overflow-hidden rounded-xl border bg-card shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
        <div className="flex items-center gap-4 border-b bg-muted/40 px-4 py-3">
          {columnKeys.map((key) => (
            <Bar key={key} className="h-3 flex-1" />
          ))}
        </div>
        {rowKeys.map((row) => (
          <div key={row} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
            {columnKeys.map((column) => (
              <Bar key={column} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
