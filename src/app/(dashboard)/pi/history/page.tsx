import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentProfile } from '@/lib/auth'
import { displayProfileName } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { OwnerFilter, type OwnerOption } from '@/components/shared/owner-filter'
import { CustomerFilter } from '@/components/shared/customer-filter'
import { PiHistoryTable } from '@/components/pi/pi-history-table'
import { WeightCalcHistoryTable } from '@/components/pi/weight-calc-history-table'
import { HistoryTabs, type HistoryView } from '@/components/pi/history-tabs'
import type {
  PiHistoryRow,
  Profile,
  CustomerSnapshot,
  WeightCalcHistoryRow,
} from '@/types'

type RawRow = Omit<PiHistoryRow, 'is_favorite'>

export default async function PiHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; owner?: string; view?: string; fav?: string; cust?: string }>
}) {
  const { q, owner, view: viewParam, fav, cust } = await searchParams
  const view: HistoryView =
    viewParam === 'trash' ? 'trash' : viewParam === 'weight' ? 'weight' : 'active'
  const onlyFav = fav === '1'

  const profile = await getCurrentProfile()
  const isAdmin = profile?.role === 'admin'
  const supabase = await createClient()

  // Owner options (admins can filter by creator) — shared by both branches.
  const ownersData = isAdmin
    ? (await supabase.from('profiles').select('id, full_name, email, chinese_name').order('full_name')).data
    : []
  const owners: OwnerOption[] = (
    (ownersData ?? []) as Pick<Profile, 'id' | 'full_name' | 'email' | 'chinese_name'>[]
  ).map((p) => ({ id: p.id, label: displayProfileName(p) }))

  // ---- 克重历史 branch: saved weight calculations ----
  if (view === 'weight') {
    let wcQuery = supabase
      .from('weight_calculations')
      .select('id, calc_number, title, total_quantity, total_weight_g, created_by, creator_display_name_snapshot, created_at')
      .order('created_at', { ascending: false })
      .limit(200)
    if (q?.trim()) wcQuery = wcQuery.ilike('calc_number', `%${q.trim()}%`)
    if (isAdmin && owner) wcQuery = wcQuery.eq('created_by', owner)

    const { data: wcData } = await wcQuery
    const wcRows = (wcData ?? []) as WeightCalcHistoryRow[]

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">克重历史</h1>
          <HistoryTabs view={view} params={{ q, owner }} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <form className="flex gap-2" action="/pi/history">
            <input type="hidden" name="view" value="weight" />
            {isAdmin && owner && <input type="hidden" name="owner" value={owner} />}
            <Input name="q" defaultValue={q ?? ''} placeholder="按计算单号搜索…" className="max-w-xs" />
            <Button type="submit" variant="outline">
              搜索
            </Button>
          </form>
          {isAdmin && <OwnerFilter owners={owners} value={owner ?? ''} basePath="/pi/history" />}
        </div>

        <WeightCalcHistoryTable rows={wcRows} isAdmin={isAdmin} owners={owners} />
      </div>
    )
  }

  // ---- PI 历史 / 回收站 branch ----
  const piView: 'active' | 'trash' = view === 'trash' ? 'trash' : 'active'

  // Current account's favorite PI ids.
  const { data: favData } = await supabase
    .from('pi_favorites')
    .select('pi_id')
    .eq('user_id', profile?.id ?? '')
  const favoriteIds = new Set((favData ?? []).map((f) => f.pi_id as string))

  let query = supabase
    .from('proforma_invoices')
    .select('id, pi_number, customer_snapshot, currency, total, status, deleted_at, created_at, created_by, creator_display_name_snapshot')
    .order('created_at', { ascending: false })
    .limit(200)

  // Recycle bin vs active.
  if (piView === 'trash') {
    query = query.not('deleted_at', 'is', null)
  } else {
    query = query.is('deleted_at', null)
  }

  if (q?.trim()) {
    query = query.ilike('pi_number', `%${q.trim()}%`)
  }
  if (isAdmin && owner) {
    query = query.eq('created_by', owner)
  }
  if (cust?.trim()) {
    query = query.eq('customer_snapshot->>name', cust.trim())
  }
  if (onlyFav) {
    const favArr = Array.from(favoriteIds)
    // Empty favorites → force an impossible filter to return nothing.
    query = query.in('id', favArr.length > 0 ? favArr : ['00000000-0000-0000-0000-000000000000'])
  }

  // Distinct customer names for the filter dropdown, scoped to the same
  // active/trash view and (for admins) the selected owner.
  let custQuery = supabase
    .from('proforma_invoices')
    .select('customer_snapshot')
    .limit(1000)
  custQuery = piView === 'trash'
    ? custQuery.not('deleted_at', 'is', null)
    : custQuery.is('deleted_at', null)
  if (isAdmin && owner) {
    custQuery = custQuery.eq('created_by', owner)
  }

  const [{ data }, { data: custData }] = await Promise.all([query, custQuery])

  const raw = (data ?? []) as RawRow[]
  const rows: PiHistoryRow[] = raw.map((r) => ({ ...r, is_favorite: favoriteIds.has(r.id) }))

  const customerNames = Array.from(
    new Set(
      ((custData ?? []) as { customer_snapshot: CustomerSnapshot | null }[])
        .map((r) => r.customer_snapshot?.name?.trim())
        .filter((n): n is string => Boolean(n)),
    ),
  ).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))

  // Preserve query params across fav toggle.
  const buildHref = (params: Record<string, string | undefined>) => {
    const merged: Record<string, string | undefined> = { q, owner, view: viewParam, fav, cust, ...params }
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(merged)) {
      if (v) sp.set(k, v)
    }
    const qs = sp.toString()
    return qs ? `/pi/history?${qs}` : '/pi/history'
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">
          {piView === 'trash' ? '回收站' : 'PI 历史'}
        </h1>
        <HistoryTabs view={view} params={{ q, owner, fav, cust }} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form className="flex gap-2" action="/pi/history">
          <Input name="q" defaultValue={q ?? ''} placeholder="按 PI 编号搜索…" className="max-w-xs" />
          {isAdmin && owner && <input type="hidden" name="owner" value={owner} />}
          {viewParam && <input type="hidden" name="view" value={viewParam} />}
          {fav && <input type="hidden" name="fav" value={fav} />}
          {cust && <input type="hidden" name="cust" value={cust} />}
          <Button type="submit" variant="outline">
            搜索
          </Button>
        </form>
        <CustomerFilter customers={customerNames} value={cust ?? ''} basePath="/pi/history" />
        {isAdmin && <OwnerFilter owners={owners} value={owner ?? ''} basePath="/pi/history" />}
        <Button asChild variant={onlyFav ? 'default' : 'outline'} size="sm">
          <Link href={buildHref({ fav: onlyFav ? undefined : '1' })}>
            {onlyFav ? '★ 只看收藏' : '☆ 只看收藏'}
          </Link>
        </Button>
      </div>

      <PiHistoryTable rows={rows} isAdmin={isAdmin} view={piView} owners={owners} />
    </div>
  )
}
