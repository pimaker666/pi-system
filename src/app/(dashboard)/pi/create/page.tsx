import { createClient } from '@/lib/supabase/server'
import { PiCreateClient } from './pi-create-client'
import type { Product, Customer, CustomerGroup, ProductGroup } from '@/types'

export default async function CreatePiPage() {
  const supabase = await createClient()

  const [products, customers, groups, productGroups, activeProfile, company] = await Promise.all([
    supabase.from('products').select('*').eq('is_active', true).order('name'),
    supabase.from('customers').select('*').is('deleted_at', null).order('name'),
    supabase.from('customer_groups').select('*').order('name'),
    supabase.from('product_groups').select('*').order('sort_order'),
    supabase
      .from('company_profiles')
      .select('pi_currency')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle(),
    supabase.from('company_settings').select('pi_currency, default_terms').eq('id', 1).maybeSingle(),
  ])

  // 生效中的公司档案优先，其次系统默认公司信息，最后回退 USD。
  const defaultCurrency = activeProfile.data?.pi_currency ?? company.data?.pi_currency ?? 'USD'

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">开具 Proforma Invoice</h1>
      <PiCreateClient
        products={(products.data ?? []) as Product[]}
        customers={(customers.data ?? []) as Customer[]}
        groups={(groups.data ?? []) as CustomerGroup[]}
        productGroups={(productGroups.data ?? []) as ProductGroup[]}
        defaultTerms={company.data?.default_terms ?? ''}
        defaultCurrency={defaultCurrency}
      />
    </div>
  )
}
