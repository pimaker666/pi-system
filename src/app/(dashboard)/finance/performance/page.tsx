import { PerformanceManager } from '@/components/finance/performance-manager'
import {
  getBusinessPerformanceByGroup,
  getBusinessPerformanceByProduct,
  getBusinessPerformanceMultiDimension,
  getBusinessPerformanceSummary,
} from '@/lib/actions/business-orders'
import { getBusinessOrderProfitRowsForPerformance } from '@/lib/actions/business-order-profit'
import { getBusinessDateKey } from '@/lib/business-orders'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { displayProfileName } from '@/lib/utils'
import { createClient } from '@/lib/supabase/server'
import { requireApproved } from '@/lib/auth'
import type {
  BusinessPerformanceDimension,
  BusinessPerformanceGroupBy,
  BusinessPerformanceGroupRow,
  BusinessPerformanceProductRow,
  BusinessPerformanceProductSource,
  DailyOrderShippingCategory,
  ProductGroup,
  Profile,
} from '@/types'

const GROUP_BY_KEYS = [
  'salesperson',
  'shop',
  'date',
  'month',
  'product_group',
  'shipping_category',
  'country',
] as const satisfies readonly BusinessPerformanceGroupBy[]

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
    'product_group',
    'shipping_category',
    'country',
    'catalog_product',
    'custom_product',
  ]
  const rawGroup = scalar('groupBy')
  const groupBy: BusinessPerformanceGroupBy =
    rawGroup && validGroups.includes(rawGroup as BusinessPerformanceGroupBy)
      ? (rawGroup as BusinessPerformanceGroupBy)
      : 'salesperson'

  const validDimensions: BusinessPerformanceDimension[] = [
    'salesperson',
    'shop',
    'country',
    'product',
    'product_group',
    'shipping_category',
    'date',
    'month',
  ]
  const parseDimension = (key: string): BusinessPerformanceDimension | null => {
    const value = scalar(key)
    return value && validDimensions.includes(value as BusinessPerformanceDimension)
      ? (value as BusinessPerformanceDimension)
      : null
  }
  const dimension1 = parseDimension('dimension1') ?? 'salesperson'
  const dimension2 = parseDimension('dimension2')
  const dimension3 = parseDimension('dimension3')
  const multiDimensions: [BusinessPerformanceDimension, BusinessPerformanceDimension | null, BusinessPerformanceDimension | null] = [
    dimension1,
    dimension2 === dimension1 ? null : dimension2,
    dimension3 === dimension1 || dimension3 === dimension2 ? null : dimension3,
  ]

  return {
    dateFrom,
    dateTo,
    salespersonIds: parseListParam(raw, 'salesperson'),
    shopIds: parseListParam(raw, 'shop'),
    productGroupIds: parseListParam(raw, 'productGroup'),
    shippingCategories: parseListParam(raw, 'shipping') as
      | DailyOrderShippingCategory[]
      | undefined,
    groupBy,
    multiDimensions,
  }
}

export default async function FinancePerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const profile = await requireApproved()
  const supabase = await createClient()
  const {
    dateFrom,
    dateTo,
    salespersonIds,
    shopIds,
    productGroupIds,
    shippingCategories,
    groupBy,
    multiDimensions,
  } = parseSearchParams(await searchParams)

  const canViewProfit = profile.role === 'admin' || profile.role === 'finance'
  const effectiveGroupBy: BusinessPerformanceGroupBy =
    !canViewProfit && (groupBy === 'catalog_product' || groupBy === 'custom_product')
      ? 'salesperson'
      : groupBy
  const [options, productGroupsResult, performanceSalespeopleResult] = await Promise.all([
    fetchDailyOrderOptions(supabase),
    supabase.from('product_groups').select('id, name, sort_order').order('sort_order'),
    supabase.rpc('get_business_performance_salespeople'),
  ])

  if (productGroupsResult.error) {
    throw new Error(`产品分组读取失败：${productGroupsResult.error.message}`)
  }
  if (performanceSalespeopleResult.error) {
    throw new Error(`业务员范围读取失败：${performanceSalespeopleResult.error.message}`)
  }

  const performanceSalespeople = (performanceSalespeopleResult.data ?? []) as Pick<
    Profile,
    'id' | 'full_name' | 'email' | 'chinese_name'
  >[]
  const allowedSalespersonIds = new Set(performanceSalespeople.map((item) => item.id))
  const restrictedSalespersonIds = salespersonIds?.filter((id) => allowedSalespersonIds.has(id))
  const filters = {
    dateFrom,
    dateTo,
    salespersonIds: canViewProfit
      ? salespersonIds
      : restrictedSalespersonIds?.length
        ? restrictedSalespersonIds
        : performanceSalespeople.map((item) => item.id),
    shopIds,
    productGroupIds,
    shippingCategories,
  }
  // 维度切换只改展示口径，筛选条件不变，因此一次取回全部维度，前端切换不再回服务端。
  const [summaryResult, groupResults, productResults, multiDimensionResult, profitRows] =
    await Promise.all([
      getBusinessPerformanceSummary(filters),
      Promise.all(GROUP_BY_KEYS.map((key) => getBusinessPerformanceByGroup(key, filters))),
      canViewProfit
        ? Promise.all([
            getBusinessPerformanceByProduct('catalog', filters),
            getBusinessPerformanceByProduct('custom', filters),
          ])
        : Promise.resolve([]),
      getBusinessPerformanceMultiDimension(multiDimensions, filters),
      canViewProfit
        ? getBusinessOrderProfitRowsForPerformance(filters)
        : Promise.resolve([]),
    ])

  if (!summaryResult.ok || !summaryResult.data) {
    throw new Error(summaryResult.error || '业绩汇总读取失败')
  }
  if (!multiDimensionResult.ok || !multiDimensionResult.data) {
    throw new Error(multiDimensionResult.error || '多维销售总览读取失败')
  }

  const groupRowsByGroupBy: Partial<
    Record<BusinessPerformanceGroupBy, BusinessPerformanceGroupRow[]>
  > = {}
  GROUP_BY_KEYS.forEach((key, index) => {
    const result = groupResults[index]
    if (!result.ok || !result.data) {
      throw new Error(result.error || '业绩分组读取失败')
    }
    groupRowsByGroupBy[key] = result.data
  })
  const productRowsBySource: Partial<
    Record<BusinessPerformanceProductSource, BusinessPerformanceProductRow[]>
  > = {}
  if (canViewProfit) {
    const sources: BusinessPerformanceProductSource[] = ['catalog', 'custom']
    sources.forEach((source, index) => {
      const result = productResults[index]
      if (!result.ok || !result.data) {
        throw new Error(result.error || '产品业绩读取失败')
      }
      productRowsBySource[source] = result.data
    })
  }

  const salespeople = performanceSalespeople.map((salesperson) => ({
    value: salesperson.id,
    label: displayProfileName(salesperson, null),
  }))
  const shops = options.shops.map((shop) => ({
    value: shop.id,
    label: shop.name,
  }))
  const productGroups = (productGroupsResult.data ?? [] as ProductGroup[]).map((group) => ({
    value: group.id,
    label: group.name,
  }))

  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-5 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
        <div className="min-w-0 space-y-2">
          <div className="inline-flex rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
            业绩分析
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">业务业绩</h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              按业务、渠道、时间、发货分类等维度汇总业务订单业绩；数据在服务端聚合，与订单级权限一致。
            </p>
          </div>
        </div>
      </section>
      <PerformanceManager
        summary={summaryResult.data}
        groupRowsByGroupBy={groupRowsByGroupBy}
        productRowsBySource={productRowsBySource}
        multiDimensionRows={multiDimensionResult.data}
        multiDimensions={multiDimensions}
        groupBy={effectiveGroupBy}
        filters={filters}
        salespeople={salespeople}
        shops={shops}
        productGroups={productGroups}
        profitRows={profitRows}
        canViewProfit={canViewProfit}
      />
    </div>
  )
}
