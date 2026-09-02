import { PerformanceManager, type RegisterablePi } from '@/components/finance/performance-manager'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import type { FinanceOrder } from '@/types'

export default async function FinancePerformancePage() {
  const profile = await requireApproved()
  const supabase = await createClient()

  const ordersResult = await supabase
    .from('finance_orders')
    .select('*')
    .order('order_date', { ascending: false })
  const orders = (ordersResult.data ?? []) as FinanceOrder[]

  let availablePis: RegisterablePi[] = []
  if (profile.role === 'sales') {
    const registeredPiIds = new Set(
      orders.map((order) => order.pi_id).filter((id): id is string => Boolean(id)),
    )
    const { data } = await supabase
      .from('proforma_invoices')
      .select('id, pi_number, customer_snapshot, total, currency')
      .eq('created_by', profile.id)
      .eq('status', 'active')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })

    availablePis = ((data ?? []) as RegisterablePi[]).filter(
      (pi) => !registeredPiIds.has(pi.id),
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {profile.role === 'sales' ? '我的业绩' : '业务业绩'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {profile.role === 'sales'
            ? '登记自己名下尚未入账的有效 PI，并查看个人业绩。'
            : '查看全部业务员按 PI 登记的订单业绩。'}
        </p>
      </div>
      <PerformanceManager profile={profile} orders={orders} availablePis={availablePis} />
    </div>
  )
}
