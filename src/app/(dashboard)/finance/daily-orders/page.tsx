import Link from 'next/link'
import { Archive, CreditCard, Plus, Settings, Upload } from 'lucide-react'
import { BusinessDailyOrderTable } from '@/components/finance/business-daily-order-table'
import { FormMultiSelect, type FormMultiSelectOption } from '@/components/shared/form-multi-select'
import { DateRangePicker } from '@/components/shared/date-range-picker'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { hasCurrentPermission, requireApproved } from '@/lib/auth'
import {
  businessDailyCurrencyOrder,
  businessDailyOrderTotals,
  type BusinessDailyLedgerOrder,
} from '@/lib/business-daily-orders'
import {
  BUSINESS_DAILY_EXPORT_LIMIT,
  BUSINESS_DAILY_LEDGER_LIMIT,
  fetchBusinessDailyLedgerWithStatusSets,
} from '@/lib/business-daily-orders-server'
import { dailyOrderFilterQuery, formatDailyMoney, parseDailyOrderFilters } from '@/lib/daily-orders'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'
import { displayProfileName } from '@/lib/utils'
import type { CurrencyCode, Customer, CustomerGroup } from '@/types'

type CurrencyTotals = Partial<Record<CurrencyCode, number>>

function sumOrdersByCurrency(
  orders: BusinessDailyLedgerOrder[],
  getAmount: (order: BusinessDailyLedgerOrder) => number,
): CurrencyTotals {
  return orders.reduce<CurrencyTotals>((totals, order) => {
    totals[order.currency] = (totals[order.currency] ?? 0) + getAmount(order)
    return totals
  }, {})
}

const TOTAL_CARDS: Array<{
  label: string
  totals: (orders: BusinessDailyLedgerOrder[]) => CurrencyTotals
}> = [
  {
    label: '订单总金额',
    totals: (orders) => sumOrdersByCurrency(orders, (order) => Number(order.total_amount)),
  },
  {
    label: '产品实收',
    totals: (orders) =>
      sumOrdersByCurrency(orders, (order) => businessDailyOrderTotals(order).productReceived),
  },
  {
    label: '运费实收',
    totals: (orders) =>
      sumOrdersByCurrency(orders, (order) => businessDailyOrderTotals(order).shippingReceived),
  },
  {
    label: '实际实收总额',
    totals: (orders) => {
      const product = sumOrdersByCurrency(
        orders,
        (order) => businessDailyOrderTotals(order).productReceived,
      )
      const shipping = sumOrdersByCurrency(
        orders,
        (order) => businessDailyOrderTotals(order).shippingReceived,
      )
      const currencies = new Set<CurrencyCode>([
        ...(Object.keys(product) as CurrencyCode[]),
        ...(Object.keys(shipping) as CurrencyCode[]),
      ])
      const totals: CurrencyTotals = {}
      for (const currency of currencies) {
        totals[currency] = (product[currency] ?? 0) + (shipping[currency] ?? 0)
      }
      return totals
    },
  },
  {
    label: '未收尾款',
    totals: (orders) => sumOrdersByCurrency(orders, (order) => order.outstanding_amount),
  },
]

export default async function DailyOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const profile = await requireApproved()
  const filters = parseDailyOrderFilters(await searchParams)
  const supabase = await createClient()
  const customersQuery = supabase.from('customers').select('*').is('deleted_at', null)
  const [ledger, canShip, options, customersResult, customerGroupsResult] = await Promise.all([
    fetchBusinessDailyLedgerWithStatusSets(supabase, filters, undefined, undefined, profile.role),
    hasCurrentPermission('orders.ship'),
    fetchDailyOrderOptions(supabase),
    ['admin', 'finance'].includes(profile.role)
      ? customersQuery.order('name')
      : customersQuery.eq('created_by', profile.id).order('name'),
    supabase.from('customer_groups').select('*').order('name'),
  ])
  const customerError = customersResult.error || customerGroupsResult.error
  if (customerError) throw new Error(`订单客户数据读取失败：${customerError.message}`)
  const { orders, settledItemIds, confirmedCommissionItemIds } = ledger
  const query = dailyOrderFilterQuery(filters)
  const canManageShops = profile.role === 'finance' || profile.role === 'admin'
  const canCreate = ['sales', 'supervisor', 'admin', 'finance'].includes(profile.role)
  const hasMoreFilters = Boolean(
    filters.shopGroups.length > 0 ||
    filters.categories.length > 0 ||
    filters.payments.length > 0 ||
    filters.completions.length > 0 ||
    filters.recordStatuses.join(',') !== 'active' ||
    filters.balanceStatuses.length > 0 ||
    filters.customerBindingStatuses.length > 0 ||
    filters.fulfillmentStatuses.length > 0 ||
    filters.markedOnly ||
    filters.commissionClearanceStatuses.length > 0,
  )

  const categoryOptions: FormMultiSelectOption[] = [
    { value: 'stock', label: '现货' },
    { value: 'sample', label: '现货样品' },
    { value: 'custom_sample', label: '定制打样' },
    { value: 'custom', label: '定制' },
    { value: 'purchase', label: '外采' },
  ]
  const paymentOptions: FormMultiSelectOption[] = [
    { value: 'full', label: '全款' },
    { value: 'deposit', label: '定金' },
    { value: 'balance', label: '尾款' },
  ]
  const settlementOptions: FormMultiSelectOption[] = [
    { value: 'settled', label: '已结算' },
    { value: 'unsettled', label: '未结算' },
  ]
  const recordStatusOptions: FormMultiSelectOption[] = [
    { value: 'active', label: '正常订单（含特殊关闭）' },
    { value: 'special_closed', label: '仅特殊关闭' },
    { value: 'voided', label: '仅已作废' },
  ]
  const balanceStatusOptions: FormMultiSelectOption[] = [
    { value: 'settled', label: '已收齐' },
    { value: 'unsettled', label: '未收齐' },
  ]
  const customerBindingOptions: FormMultiSelectOption[] = [
    { value: 'bound', label: '已绑定客户' },
    { value: 'unbound', label: '未绑定客户' },
  ]
  const fulfillmentOptions: FormMultiSelectOption[] = [
    { value: 'fully_shipped', label: '全部发货' },
    { value: 'partially_shipped', label: '部分发货' },
    { value: 'unshipped', label: '未发货' },
  ]
  const commissionClearanceOptions: FormMultiSelectOption[] = [
    { value: 'cleared', label: '已结清' },
    { value: 'uncleared', label: '未结清' },
  ]

  const selectClassName =
    'h-10 min-w-0 rounded-md border border-input bg-card px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

  return (
    <div className="space-y-5">
      <section className="rounded-xl border bg-card p-5 shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <div className="inline-flex rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
              订单台账
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">财务每日订单台账</h1>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
                每行对应一个产品；当前筛选最多显示 {BUSINESS_DAILY_LEDGER_LIMIT} 行、导出 {BUSINESS_DAILY_EXPORT_LIMIT} 行。
                建单、收款、发货、退货与结单全部使用业务订单作为单一事实源。
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/finance/daily-orders/legacy" target="_blank" rel="noopener noreferrer"><Archive className="h-4 w-4" />历史台账</Link>
            </Button>
            {canManageShops && (
              <>
                <Button asChild variant="outline" size="sm">
                  <Link href="/finance/daily-orders/settings" target="_blank" rel="noopener noreferrer"><Settings className="h-4 w-4" />店铺设置</Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href="/finance/daily-orders/settings" target="_blank" rel="noopener noreferrer"><CreditCard className="h-4 w-4" />收款账户</Link>
                </Button>
              </>
            )}
            {canCreate && (
              <>
                <Button asChild variant="outline" size="sm">
                  <Link href="/finance/daily-orders/import" target="_blank" rel="noopener noreferrer"><Upload className="h-4 w-4" />批量导入</Link>
                </Button>
                <Button asChild size="sm">
                  <Link href="/finance/daily-orders/new" target="_blank" rel="noopener noreferrer"><Plus className="h-4 w-4" />新建订单</Link>
                </Button>
              </>
            )}
          </div>
        </div>
      </section>

      <form className="overflow-hidden rounded-xl border bg-card shadow-[0_2px_8px_rgb(15_23_42/0.04)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">筛选订单</h2>
            <p className="text-xs text-muted-foreground">常用条件置顶，低频条件收进更多筛选。</p>
          </div>
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
            共 {orders.length} 个订单
          </span>
        </div>
        <div className="grid gap-3 p-4 md:grid-cols-4 xl:grid-cols-12">
          <Input
            name="q"
            defaultValue={filters.q}
            placeholder="订单号/平台单号/发货单号/收款账户/产品/SKU"
            className="md:col-span-2 xl:col-span-4"
          />
          <DateRangePicker
            from={filters.dateFrom}
            to={filters.dateTo}
            className="md:col-span-2 xl:col-span-3"
          />
          <FormMultiSelect
            name="shops"
            label="店铺"
            allLabel="全部店铺"
            options={options.shops.map((shop) => ({ value: shop.id, label: shop.name }))}
            defaultSelected={filters.shops}
            triggerClassName={selectClassName + ' xl:col-span-2'}
            panelClassName="w-64"
          />
          <FormMultiSelect
            name="salespeople"
            label="业务员"
            allLabel="全部业务员"
            options={options.salespeople.map((person) => ({
              value: person.id,
              label: displayProfileName(person),
            }))}
            defaultSelected={filters.salespeople}
            triggerClassName={selectClassName + ' xl:col-span-2'}
            panelClassName="w-56"
          />
          <FormMultiSelect
            name="settlementStatuses"
            label="结算状态"
            allLabel="全部结算状态"
            options={settlementOptions}
            defaultSelected={filters.settlementStatuses}
            triggerClassName={selectClassName + ' xl:col-span-2'}
            emptyValue="all"
          />
          <div className="flex flex-wrap gap-2 md:col-span-4 xl:col-span-3">
            <Button type="submit">应用筛选</Button>
            <Button asChild type="button" variant="outline">
              <Link href="/finance/daily-orders">重置</Link>
            </Button>
          </div>
        </div>
        <details className="group border-t" open={hasMoreFilters}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
            <span>更多筛选</span>
            <span className="text-xs font-normal text-muted-foreground">店铺分组、分类、状态、标记与结清条件 ▼</span>
          </summary>
          <div className="grid gap-3 border-t bg-muted/15 p-4 md:grid-cols-4 xl:grid-cols-6">
            <FormMultiSelect
              name="shopGroups"
              label="店铺分组"
              allLabel="全部店铺分组"
              options={options.groups.map((group) => ({ value: group.id, label: group.name }))}
              defaultSelected={filters.shopGroups}
              triggerClassName={selectClassName}
              panelClassName="w-56"
            />
            <FormMultiSelect
              name="categories"
              label="发货分类"
              allLabel="全部发货分类"
              options={categoryOptions}
              defaultSelected={filters.categories}
              triggerClassName={selectClassName}
            />
            <FormMultiSelect
              name="payments"
              label="收款分类"
              allLabel="全部收款分类"
              options={paymentOptions}
              defaultSelected={filters.payments}
              triggerClassName={selectClassName}
            />
            <FormMultiSelect
              name="completions"
              label="订单状态"
              allLabel="订单状态"
              options={[
                { value: 'completed', label: '已完成' },
                { value: 'incomplete', label: '未完成' },
              ]}
              defaultSelected={filters.completions}
              triggerClassName={selectClassName}
            />
            <FormMultiSelect
              name="recordStatuses"
              label="记录状态"
              allLabel="所有订单记录"
              options={recordStatusOptions}
              defaultSelected={filters.recordStatuses}
              triggerClassName={selectClassName}
              panelClassName="w-64"
              emptyValue="all"
            />
            <select name="markedOnly" defaultValue={filters.markedOnly ?? ''} className={selectClassName}>
              <option value="">全部订单标记</option>
              <option value="1">只看我标记的订单</option>
            </select>
            <FormMultiSelect
              name="balanceStatuses"
              label="尾款状态"
              allLabel="全部尾款状态"
              options={balanceStatusOptions}
              defaultSelected={filters.balanceStatuses}
              triggerClassName={selectClassName}
            />
            <FormMultiSelect
              name="customerBindingStatuses"
              label="客户状态"
              allLabel="全部客户状态"
              options={customerBindingOptions}
              defaultSelected={filters.customerBindingStatuses}
              triggerClassName={selectClassName}
            />
            <FormMultiSelect
              name="fulfillmentStatuses"
              label="发货状态"
              allLabel="全部发货状态"
              options={fulfillmentOptions}
              defaultSelected={filters.fulfillmentStatuses}
              triggerClassName={selectClassName}
            />
            <FormMultiSelect
              name="commissionClearanceStatuses"
              label="提成结清"
              allLabel="全部提成结清状态"
              options={commissionClearanceOptions}
              defaultSelected={filters.commissionClearanceStatuses}
              triggerClassName={selectClassName}
              panelClassName="w-56"
            />
          </div>
        </details>
      </form>

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">当前筛选汇总</h2>
            <p className="text-xs text-muted-foreground">按币种分别统计，不做跨币种折算。</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
          {TOTAL_CARDS.map(({ label, totals }) => {
            const totalsByCurrency = totals(orders)
            const emphasis = label === '实际实收总额'
            const warning = label === '未收尾款'
            return (
              <Card
                key={label}
                className={
                  emphasis
                    ? 'border-primary/25 bg-primary/[0.04]'
                    : warning
                      ? 'border-amber-200 bg-amber-50/60'
                      : 'bg-card'
                }
              >
                <CardHeader className="p-4 pb-1">
                  <CardTitle className={emphasis ? 'text-sm text-primary' : 'text-sm text-muted-foreground'}>
                    {label}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 px-4 pb-4 text-base font-semibold tabular-nums">
                  {businessDailyCurrencyOrder(totalsByCurrency).map((currency) => (
                    <div key={currency}>{formatDailyMoney(totalsByCurrency[currency] ?? 0, currency)}</div>
                  ))}
                </CardContent>
              </Card>
            )
          })}
        </div>
      </section>

      <BusinessDailyOrderTable
        orders={orders}
        actor={profile}
        customers={(customersResult.data ?? []) as Customer[]}
        customerGroups={(customerGroupsResult.data ?? []) as CustomerGroup[]}
        filterQuery={query}
        settledItemIds={settledItemIds}
        confirmedCommissionItemIds={confirmedCommissionItemIds}
        canShip={canShip}
      />
    </div>
  )
}
