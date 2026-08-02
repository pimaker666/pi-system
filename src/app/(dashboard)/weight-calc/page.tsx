import { createClient } from '@/lib/supabase/server'
import { WeightCalcClient, type PiOption } from './weight-calc-client'
import type { Product, ProductGroup, CustomerSnapshot } from '@/types'

export default async function WeightCalcPage() {
  const supabase = await createClient()

  const [products, productGroups, pis] = await Promise.all([
    supabase.from('products').select('*').eq('is_active', true).order('name'),
    supabase.from('product_groups').select('*').order('sort_order'),
    supabase
      .from('proforma_invoices')
      .select('id, pi_number, customer_snapshot, created_at')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(200),
  ])

  const piOptions: PiOption[] = (pis.data ?? []).map((p) => {
    const snap = p.customer_snapshot as CustomerSnapshot | null
    return {
      id: p.id as string,
      pi_number: p.pi_number as string,
      customer_name: snap?.company || snap?.name || '',
      created_at: p.created_at as string,
    }
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">计算重量</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          导入产品或直接导入某张 PI，按克重与数量自动计算每项及合计的总重量（单位 KG）。
        </p>
      </div>
      <WeightCalcClient
        products={(products.data ?? []) as Product[]}
        groups={(productGroups.data ?? []) as ProductGroup[]}
        pis={piOptions}
      />
    </div>
  )
}
