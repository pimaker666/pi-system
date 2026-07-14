import { createClient } from '@/lib/supabase/server'

export function monthRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1)
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1)
  return { start: start.toISOString(), end: end.toISOString() }
}

export interface DashboardStats {
  productCount: number
  customerCount: number
  piCount: number
  monthPiCount: number
}

/**
 * Aggregate dashboard counters. RLS ensures a sales user only counts their own
 * customers / PIs, while an admin counts everything.
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  const supabase = await createClient()
  const { start, end } = monthRange()

  const [products, customers, pis, monthPis] = await Promise.all([
    supabase.from('products').select('id', { count: 'exact', head: true }),
    supabase.from('customers').select('id', { count: 'exact', head: true }),
    supabase.from('proforma_invoices').select('id', { count: 'exact', head: true }),
    supabase
      .from('proforma_invoices')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', start)
      .lt('created_at', end),
  ])

  return {
    productCount: products.count ?? 0,
    customerCount: customers.count ?? 0,
    piCount: pis.count ?? 0,
    monthPiCount: monthPis.count ?? 0,
  }
}
