import { cn } from '@/lib/utils'

function Bar({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />
}

const TABS = ['a', 'b', 'c']
const ITEMS = ['1', '2', '3', '4', '5']

export default function ApprovalsLoading() {
  return (
    <div className="space-y-6" role="status" aria-live="polite">
      <span className="sr-only">页面加载中</span>
      <div className="space-y-2">
        <Bar className="h-8 w-32" />
        <Bar className="h-4 w-full max-w-2xl" />
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map((key, index) => (
          <Bar key={key} className={cn('h-9 w-24', index === 0 && 'bg-primary/20')} />
        ))}
      </div>

      <div className="space-y-3">
        {ITEMS.map((key) => (
          <div
            key={key}
            className="rounded-xl border bg-card p-4 shadow-[0_2px_8px_rgb(15_23_42/0.04)]"
          >
            <div className="flex items-center justify-between gap-3">
              <Bar className="h-5 w-48" />
              <Bar className="h-6 w-16 rounded-full" />
            </div>
            <Bar className="mt-3 h-4 w-full max-w-3xl" />
            <Bar className="mt-2 h-4 w-2/3 max-w-xl" />
          </div>
        ))}
      </div>
    </div>
  )
}
