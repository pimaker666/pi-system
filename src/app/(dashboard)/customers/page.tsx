import Link from 'next/link'
import { UsersRound } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getCurrentProfile } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { NewCustomerButton } from '@/components/customers/new-customer-button'
import { CustomerFilters } from '@/components/customers/customer-filters'
import { CustomerTable, type CustomerRow } from '@/components/customers/customer-table'
import type { OwnerOption } from '@/components/shared/owner-filter'
import type { CustomerGroup, Profile } from '@/types'

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; group?: string; country?: string; owner?: string }>
}) {
  const { q, group, country, owner } = await searchParams
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

  const [{ data: customerData }, { data: groupData }, { data: profileData }, { data: countryData }] =
    await Promise.all([
      customerQuery,
      supabase.from('customer_groups').select('*').order('name'),
      supabase.from('profiles').select('id, full_name, email').order('full_name'),
      supabase.from('customers').select('country'),
    ])

  const customers = (customerData ?? []) as CustomerRow[]
  const groups = (groupData ?? []) as CustomerGroup[]
  const profiles = (profileData ?? []) as Pick<Profile, 'id' | 'full_name' | 'email'>[]

  const owners: OwnerOption[] = profiles.map((p) => ({
    id: p.id,
    label: p.full_name || p.email || '未知账号',
  }))

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
      />

      <CustomerTable
        customers={customers}
        groups={groups}
        owners={owners}
        isAdmin={isAdmin}
      />
    </div>
  )
}
