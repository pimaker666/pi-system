import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { BusinessOrderForm } from '@/components/finance/business-order-form'
import { Button } from '@/components/ui/button'
import { getBusinessOrderEditConstraints } from '@/lib/actions/business-orders'
import { requireApproved } from '@/lib/auth'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'
import type {
  BusinessOrderWithDetails,
  Customer,
  CustomerGroup,
  Product,
  ProductGroup,
} from '@/types'

export default async function EditBusinessOrderPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const profile = await requireApproved()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('business_orders')
    .select(
      '*, business_order_items(*), business_order_payments(*), business_order_attachments(*)',
    )
    .eq('id', id)
    .eq('business_order_attachments.status', 'active')
    .single()

  if (error || !data) notFound()
  const order = data as BusinessOrderWithDetails & { closed_at?: string | null }
  const isEditableStatus = ['draft', 'rejected'].includes(order.status) && !order.closed_at
  const canEdit =
    isEditableStatus &&
    (profile.role === 'admin' ||
      ((profile.role === 'sales' || profile.role === 'supervisor') &&
        order.salesperson_id === profile.id))
  const canInspectLocked =
    (profile.role === 'admin' || profile.role === 'finance') &&
    (order.status === 'completed' || Boolean(order.closed_at))
  if (!canEdit && !canInspectLocked) redirect(`/finance/daily-orders/${id}`)

  const [
    customersResult,
    customerGroupsResult,
    productsResult,
    productGroupsResult,
    constraintsResult,
    dailyOptions,
  ] = await Promise.all([
    profile.role === 'finance'
      ? Promise.resolve({ data: [] as Customer[], error: null })
      : profile.role === 'admin'
        ? supabase.from('customers').select('*').order('name')
        : supabase.from('customers').select('*').eq('created_by', profile.id).order('name'),
    profile.role === 'finance'
      ? Promise.resolve({ data: [] as CustomerGroup[], error: null })
      : supabase.from('customer_groups').select('*').order('name'),
    supabase.from('products').select('*').eq('is_active', true).order('name'),
    supabase.from('product_groups').select('*').order('sort_order'),
    getBusinessOrderEditConstraints(id),
    fetchDailyOrderOptions(supabase),
  ])

  const loadError =
    customersResult.error ||
    customerGroupsResult.error ||
    productsResult.error ||
    productGroupsResult.error
  if (loadError) throw new Error(`订单基础数据读取失败：${loadError.message}`)
  if (!constraintsResult.ok) {
    throw new Error(constraintsResult.error ?? '订单编辑约束读取失败')
  }

  const customers = [...((customersResult.data ?? []) as Customer[])]
  if (order.customer_id && !customers.some((customer) => customer.id === order.customer_id)) {
    customers.push({
      id: order.customer_id,
      ...order.customer_snapshot,
      group_id: null,
      created_by: order.salesperson_id,
      created_at: order.created_at,
      updated_at: order.updated_at,
    })
  }

  const shops = [...dailyOptions.shops]
  if (order.shop_id && !shops.some((shop) => shop.id === order.shop_id)) {
    shops.push({
      id: order.shop_id,
      name: order.shop_name_snapshot ?? '已停用店铺',
      group_id: order.shop_group_id,
      is_active: false,
      default_currency: order.currency,
      created_by: null,
      created_at: order.created_at,
      updated_at: order.updated_at,
      salespersonIds: order.salesperson_id ? [order.salesperson_id] : [],
    })
  } else if (order.shop_id && order.salesperson_id) {
    const currentShop = shops.find((shop) => shop.id === order.shop_id)
    if (currentShop && !currentShop.salespersonIds.includes(order.salesperson_id)) {
      currentShop.salespersonIds = [...currentShop.salespersonIds, order.salesperson_id]
    }
  }

  const salespeople = [...dailyOptions.salespeople]
  if (order.salesperson_id && !salespeople.some((person) => person.id === order.salesperson_id)) {
    salespeople.push({
      id: order.salesperson_id,
      full_name: order.salesperson_name_snapshot,
      email: '',
      chinese_name: order.salesperson_name_snapshot,
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" className="h-8 w-8">
          <Link href={`/finance/daily-orders/${id}`}><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">编辑 {order.order_number}</h1>
          <p className="text-sm text-muted-foreground">
            {order.status === 'completed' || order.closed_at
              ? '订单已锁定；此页仅用于查看数据库返回的编辑约束。'
              : '有有效收款分摊或发货事实的明细会按数据库规则限制修改。'}
          </p>
        </div>
      </div>
      <BusinessOrderForm
        profile={profile}
        customers={customers}
        customerGroups={(customerGroupsResult.data ?? []) as CustomerGroup[]}
        productGroups={(productGroupsResult.data ?? []) as ProductGroup[]}
        products={(productsResult.data ?? []) as Product[]}
        shops={shops}
        salespeople={salespeople}
        initialOrder={order}
        editConstraints={constraintsResult.data}
      />
    </div>
  )
}
