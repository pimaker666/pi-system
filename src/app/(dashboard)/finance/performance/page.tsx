import {
  PerformanceManager,
  type BusinessOrderListRow,
} from '@/components/finance/performance-manager'
import { requireApproved } from '@/lib/auth'
import { fetchCurrentCustomerCountries } from '@/lib/business-daily-orders-server'
import { PERFORMANCE_PAGE_SIZE } from '@/lib/business-order-cost'
import { BUSINESS_ORDER_STATUS_LABELS } from '@/lib/business-orders'
import { createClient } from '@/lib/supabase/server'
import type { BusinessOrderStatus } from '@/types'

const ALLOCATION_SELECT =
  'business_order_payment_allocations(amount, voided_at, transfer:business_customer_transfers!business_order_payment_allocations_transfer_id_fkey(voided_at, exchange_rate_to_cny))'

const SALESPERSON_SELECT =
  'salesperson:profiles!salesperson_id(id, chinese_name, full_name, email)'

function parseSearchParams(raw: Record<string, string | string[] | undefined>) {
  const scalar = (key: string) => {
    const v = raw[key]
    return Array.isArray(v) ? v[0] : v
  }
  const q = (scalar('q') ?? '').trim()
  const rawStatus = (scalar('status') ?? '').trim()
  const validStatuses = Object.keys(BUSINESS_ORDER_STATUS_LABELS)
  const status = rawStatus === 'special_closed' || validStatuses.includes(rawStatus) ? rawStatus : ''
  const page = Math.max(1, Number(scalar('page') || 1) || 1)
  return { q, status, page }
}

export default async function FinancePerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireApproved()
  const supabase = await createClient()
  const { q, status, page } = parseSearchParams(await searchParams)
  const offset = (page - 1) * PERFORMANCE_PAGE_SIZE

  let ordersQuery = supabase
    .from('business_orders')
    .select(`*, ${ALLOCATION_SELECT}, ${SALESPERSON_SELECT}`)
    .is('voided_at', null)
    .order('order_date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + PERFORMANCE_PAGE_SIZE - 1)

  let countQuery = supabase
    .from('business_orders')
    .select('id', { count: 'exact', head: true })
    .is('voided_at', null)

  if (status === 'special_closed') {
    ordersQuery = ordersQuery.not('closed_at', 'is', null)
    countQuery = countQuery.not('closed_at', 'is', null)
  } else if (status) {
    ordersQuery = ordersQuery.eq('status', status as BusinessOrderStatus)
    countQuery = countQuery.eq('status', status as BusinessOrderStatus)
  }

  if (q) {
    const orFilter = [
      `order_number.ilike.%${q}%`,
      `external_order_number.ilike.%${q}%`,
      `customer_snapshot.ilike.%${q}%`,
    ].join(',')
    ordersQuery = ordersQuery.or(orFilter)
    countQuery = countQuery.or(orFilter)
  }

  const [ordersResult, countResult] = await Promise.all([ordersQuery, countQuery])

  if (ordersResult.error) throw new Error(`业务订单读取失败：${ordersResult.error.message}`)
  if (countResult.error) throw new Error(`业务订单计数读取失败：${countResult.error.message}`)

  const baseOrders = (ordersResult.data ?? []) as BusinessOrderListRow[]
  const totalCount = countResult.count ?? 0

  // 国旗读实时客户国家（走 security definer RPC），未关联客户时回落到下单快照。
  const countries = await fetchCurrentCustomerCountries(
    supabase,
    baseOrders.map((order) => order.id),
  )
  const orders = baseOrders.map((order) => ({
    ...order,
    current_customer_country: countries.get(order.id) ?? null,
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">业务业绩</h1>
        <p className="text-sm text-muted-foreground">
          本页为业务订单的只读汇总，数据与每日订单同源；请前往每日订单查看详情或维护订单。
        </p>
      </div>
      <PerformanceManager
        orders={orders}
        totalCount={totalCount}
        currentPage={page}
        pageSize={PERFORMANCE_PAGE_SIZE}
        filters={{ q, status }}
      />
    </div>
  )
}
