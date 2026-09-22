import { PerformanceManager } from '@/components/finance/performance-manager'
import {
  getBusinessPerformanceByGroup,
  getBusinessPerformanceSummary,
} from '@/lib/actions/business-orders'
import { getBusinessDateKey } from '@/lib/business-orders'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { displayProfileName } from '@/lib/utils'
import { createClient } from '@/lib/supabase/server'
import { requireApproved } from '@/lib/auth'
import type {
  BusinessFulfillmentType,
  BusinessPerformanceGroupBy,
  DailyOrderShippingCategory,
} from '@/types'

function getCurrentMonthRange() {
  const today = getBusinessDateKey()
  const [year, month] = today.split('-').map(Number)
  const start = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`
  const endDate = new Date(year, month, 0)
  const end = `${String(endDate.getFullYear()).padStart(4, '0')}-${String(
    endDate.getMonth() + 1,
  ).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`
  return { start, end }
}

function parseListParam(
  raw: Record<string, string | string[] | undefined>,
  key: string,
): string[] | undefined {
  const value = raw[key]
  if (!value) return undefined
  const list = Array.isArray(value) ? value : value.split(',')
  const trimmed = list.map((item) => item.trim()).filter(Boolean)
  return trimmed.length > 0 ? trimmed : undefined
}

function parseSearchParams(raw: Record<string, string | string[] | undefined>) {
  const scalar = (key: string) => {
    const value = raw[key]
    return Array.isArray(value) ? value[0] : value
  }

  const { start, end } = getCurrentMonthRange()
  const dateFrom = scalar('dateFrom') || start
  const dateTo = scalar('dateTo') || end

  const validGroups: BusinessPerformanceGroupBy[] = [
    'salesperson',
    'shop',
    'date',
    'month',
    'fulfillment_type',
    'shipping_category',
  ]
  const rawGroup = scalar('groupBy')
  const groupBy: BusinessPerformanceGroupBy =
    rawGroup && validGroups.includes(rawGroup as BusinessPerformanceGroupBy)
      ? (rawGroup as BusinessPerformanceGroupBy)
      : 'salesperson'

  return {
    dateFrom,
    dateTo,
    salespersonIds: parseListParam(raw, 'salesperson'),
    shopIds: parseListParam(raw, 'shop'),
    fulfillmentTypes: parseListParam(raw, 'fulfillment') as
      | BusinessFulfillmentType[]
      | undefined,
    shippingCategories: parseListParam(raw, 'shipping') as
      | DailyOrderShippingCategory[]
      | undefined,
    groupBy,
  }
}

export default async function FinancePerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireApproved()
  const supabase = await createClient()
  const {
    dateFrom,
    dateTo,
    salespersonIds,
    shopIds,
    fulfillmentTypes,
    shippingCategories,
    groupBy,
  } = parseSearchParams(await searchParams)

  const [options, summaryResult, groupResult] = await Promise.all([
    fetchDailyOrderOptions(supabase),
    getBusinessPerformanceSummary({
      dateFrom,
      dateTo,
      salespersonIds,
      shopIds,
      fulfillmentTypes,
      shippingCategories,
    }),
    getBusinessPerformanceByGroup(groupBy, {
      dateFrom,
      dateTo,
      salespersonIds,
      shopIds,
      fulfillmentTypes,
      shippingCategories,
    }),
  ])

  if (!summaryResult.ok || !summaryResult.data) {
    throw new Error(summaryResult.error || '业绩汇总读取失败')
  }
  if (!groupResult.ok || !groupResult.data) {
    throw new Error(groupResult.error || '业绩分组读取失败')
  }

  const salespeople = options.salespeople.map((profile) => ({
    value: profile.id,
    label: displayProfileName(profile, null),
  }))
  const shops = options.shops.map((shop) => ({
    value: shop.id,
    label: shop.name,
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">业务业绩</h1>
        <p className="text-sm text-muted-foreground">
          按业务、渠道、时间、发货分类等维度汇总业务订单业绩；数据在服务端聚合，与订单级权限一致。
        </p>
      </div>
      <PerformanceManager
        summary={summaryResult.data}
        groupRows={groupResult.data}
        groupBy={groupBy}
        filters={{
          dateFrom,
          dateTo,
          salespersonIds,
          shopIds,
          fulfillmentTypes,
          shippingCategories,
        }}
        salespeople={salespeople}
        shops={shops}
      />
    </div>
  )
}
