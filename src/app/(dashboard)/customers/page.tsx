import Link from 'next/link'
import { UsersRound } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getCurrentProfile } from '@/lib/auth'
import { displayProfileName } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { NewCustomerButton } from '@/components/customers/new-customer-button'
import { CustomerFilters } from '@/components/customers/customer-filters'
import {
  CustomerTable,
  type CustomerOrderStatsMap,
  type CustomerRow,
  type CustomerSortField,
} from '@/components/customers/customer-table'
import type { OwnerOption } from '@/components/shared/owner-filter'
import type { CustomerCommissionTag, CustomerGroup, Profile } from '@/types'

const customerSortFields: CustomerSortField[] = ['amount', 'lastOrder', 'createdAt', 'customOrderCount']

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; group?: string; country?: string; owner?: string; amountMin?: string; amountMax?: string; lastOrderFrom?: string; lastOrderTo?: string; sortBy?: string; sortDirection?: string }>
}) {
  const { q, group, country, owner, amountMin, amountMax, lastOrderFrom, lastOrderTo, sortBy: rawSortBy, sortDirection: rawSortDirection } = await searchParams
  const sortBy = customerSortFields.includes(rawSortBy as CustomerSortField)
    ? rawSortBy as CustomerSortField
    : 'amount'
  const sortDirection = rawSortDirection === 'asc' ? 'asc' : 'desc'
  const profile = await getCurrentProfile()
  const isAdmin = profile?.role === 'admin'
  const supabase = await createClient()

  let customerQuery = supabase
    .from('customers')
    .select('*, customer_groups(name)')
    .order('created_at', { ascending: false })

  if (q?.trim()) {
    const term = q.trim()
    customerQuery = customerQuery.or(
      `name.ilike.%${term}%,company.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`,
    )
  }
  if (group === '__none__') customerQuery = customerQuery.is('group_id', null)
  else if (group) customerQuery = customerQuery.eq('group_id', group)
  if (country) customerQuery = customerQuery.eq('country', country)
  if (isAdmin && owner) customerQuery = customerQuery.eq('created_by', owner)

  const [{ data: customerData }, { data: groupData }, { data: profileData }, { data: countryData }, { data: tagData }] = await Promise.all([
    customerQuery,
    supabase.from('customer_groups').select('*').order('name'),
    supabase
      .from('profiles')
      .select('id, full_name, email, chinese_name, role, status')
      .order('full_name'),
    supabase.from('customers').select('country'),
    supabase
      .from('finance_customer_commission_tags')
      .select('tag_color, label, product_commission_rate, sort_order')
      .order('sort_order', { ascending: true })
      .order('label', { ascending: true }),
  ])

  let customers = (customerData ?? []) as CustomerRow[]
  const groups = (groupData ?? []) as CustomerGroup[]
  const customerTags: CustomerCommissionTag[] = (
    (tagData ?? []) as Array<{
      tag_color: string
      label: string
      product_commission_rate: number | string
      sort_order: number | string
    }>
  ).map((row) => ({
    tag_color: row.tag_color,
    label: row.label,
    product_commission_rate: Number(row.product_commission_rate),
    sort_order: Number(row.sort_order),
  }))
  const profiles = (profileData ?? []) as Pick<
    Profile,
    'id' | 'full_name' | 'email' | 'chinese_name' | 'role' | 'status'
  >[]

  const statsMap: CustomerOrderStatsMap = {}
  if (customers.length > 0) {
    const { data: statsData } = await supabase.rpc('get_customer_order_stats', {
      p_customer_ids: customers.map((c) => c.id),
    })
    for (const s of (statsData ?? []) as {
      customer_id: string
      last_year_amount_cny: number | string | null
      last_year_amount_usd: number | string | null
      last_order_date: string | null
      custom_order_count: number | null
    }[]) {
      statsMap[s.customer_id] = {
        lastYearAmountCny: Number(s.last_year_amount_cny ?? 0),
        lastYearAmountUsd: Number(s.last_year_amount_usd ?? 0),
        lastOrderDate: s.last_order_date,
        customOrderCount: Number(s.custom_order_count ?? 0),
      }
    }
  }

  const minAmount = Number(amountMin)
  const maxAmount = Number(amountMax)
  customers = customers.filter((customer) => {
    const stats = statsMap[customer.id]
    if (Number.isFinite(minAmount) && minAmount > 0 && (stats?.lastYearAmountCny ?? 0) < minAmount) return false
    if (Number.isFinite(maxAmount) && maxAmount > 0 && (stats?.lastYearAmountCny ?? 0) > maxAmount) return false
    if (lastOrderFrom && (!stats?.lastOrderDate || stats.lastOrderDate < lastOrderFrom)) return false
    if (lastOrderTo && (!stats?.lastOrderDate || stats.lastOrderDate > lastOrderTo)) return false
    return true
  })
  customers.sort((left, right) => {
    const sortValue = (customer: CustomerRow): number | string | undefined => {
      const stats = statsMap[customer.id]
      if (sortBy === 'amount') return stats?.lastYearAmountCny || stats?.lastYearAmountUsd || 0
      if (sortBy === 'lastOrder') return stats?.lastOrderDate ?? undefined
      if (sortBy === 'createdAt') return customer.created_at
      return stats?.customOrderCount ?? 0
    }
    const leftValue = sortValue(left)
    const rightValue = sortValue(right)
    if (leftValue === undefined || rightValue === undefined) {
      if (leftValue === rightValue) return 0
      return leftValue === undefined ? 1 : -1
    }
    const difference = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue))
    return sortDirection === 'asc' ? difference : -difference
  })

  const owners: OwnerOption[] = profiles.map((p) => ({
    id: p.id,
    label: displayProfileName(p),
  }))
  const transferOwners: OwnerOption[] = profiles
    .filter((p) => p.status === 'approved' && p.role !== 'finance')
    .map((p) => ({ id: p.id, label: displayProfileName(p) }))

  const countries = Array.from(
    new Set(
      (countryData ?? [])
        .map((r: { country: string | null }) => r.country)
        .filter(Boolean) as string[],
    ),
  ).sort()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">客户</h1>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/customers/groups">
              <UsersRound className="h-4 w-4" />
              管理分组
            </Link>
          </Button>
          <NewCustomerButton groups={groups} />
        </div>
      </div>

      <CustomerFilters
        groups={groups}
        countries={countries}
        owners={owners}
        isAdmin={isAdmin}
        q={q ?? ''}
        group={group ?? ''}
        country={country ?? ''}
        owner={owner ?? ''}
        amountMin={amountMin ?? ''}
        amountMax={amountMax ?? ''}
        lastOrderFrom={lastOrderFrom ?? ''}
        lastOrderTo={lastOrderTo ?? ''}
      />

      <CustomerTable
        customers={customers}
        groups={groups}
        owners={owners}
        transferOwners={transferOwners}
        isAdmin={isAdmin}
        stats={statsMap}
        customerTags={customerTags}
        sortBy={sortBy}
        sortDirection={sortDirection}
      />
    </div>
  )
}
