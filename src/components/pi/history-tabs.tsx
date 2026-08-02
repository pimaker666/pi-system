import Link from 'next/link'
import { cn } from '@/lib/utils'

export type HistoryView = 'active' | 'trash' | 'weight'

/**
 * The three-way segmented toggle shared by the PI history page: PI 历史 /
 * 克重历史 / 回收站. Rendered on both the PI-list and weight-calc-list branches
 * so the two views switch in place. Non-active params (search/owner/customer)
 * are carried across so the current filter survives a toggle.
 */
export function HistoryTabs({
  view,
  params,
}: {
  view: HistoryView
  params: Record<string, string | undefined>
}) {
  const build = (v: HistoryView) => {
    const merged: Record<string, string | undefined> = {
      ...params,
      view: v === 'active' ? undefined : v,
    }
    const sp = new URLSearchParams()
    for (const [k, val] of Object.entries(merged)) if (val) sp.set(k, val)
    const qs = sp.toString()
    return qs ? `/pi/history?${qs}` : '/pi/history'
  }

  const tab = (v: HistoryView, label: string) => (
    <Link
      href={build(v)}
      className={cn(
        'rounded px-3 py-1 text-sm',
        view === v
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground',
      )}
    >
      {label}
    </Link>
  )

  return (
    <div className="flex items-center gap-1 rounded-md border p-0.5">
      {tab('active', 'PI 历史')}
      {tab('weight', '克重历史')}
      {tab('trash', '回收站')}
    </div>
  )
}
