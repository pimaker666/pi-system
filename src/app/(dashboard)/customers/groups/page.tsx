import { createClient } from '@/lib/supabase/server'
import { GroupManager, type GroupWithCount } from '@/components/customers/group-manager'
import type { CustomerGroup } from '@/types'

export default async function CustomerGroupsPage() {
  const supabase = await createClient()

  const [{ data: groupData }, { data: customerData }] = await Promise.all([
    supabase.from('customer_groups').select('*').order('name'),
    supabase.from('customers').select('group_id'),
  ])

  const groups = (groupData ?? []) as CustomerGroup[]
  const counts = new Map<string, number>()
  ;(customerData ?? []).forEach((row: { group_id: string | null }) => {
    if (row.group_id) counts.set(row.group_id, (counts.get(row.group_id) ?? 0) + 1)
  })

  const withCounts: GroupWithCount[] = groups.map((g) => ({
    ...g,
    customer_count: counts.get(g.id) ?? 0,
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">客户分组</h1>
        <p className="text-sm text-muted-foreground">对客户进行分类管理，便于筛选与统计。</p>
      </div>
      <GroupManager groups={withCounts} />
    </div>
  )
}
