import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { BusinessOrderForm } from '@/components/finance/business-order-form'
import { Button } from '@/components/ui/button'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import type { BusinessOrderWithDetails, Customer, CustomerGroup, Product } from '@/types'

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
    .select('*, business_order_items(*), business_order_payments(*)')
    .eq('id', id)
    .single()

  if (error || !data) notFound()
  const order = data as BusinessOrderWithDetails
  const salesCanEdit =
    (profile.role === 'sales' || profile.role === 'supervisor') &&
    order.salesperson_id === profile.id &&
    ['draft', 'rejected'].includes(order.status)
  const privilegedCanCorrect =
    (profile.role === 'admin' || profile.role === 'finance') && order.status === 'completed'
  if (!salesCanEdit && !privilegedCanCorrect) redirect(`/finance/performance/${id}`)

  const [customersResult, groupsResult, productsResult] = await Promise.all([
    profile.role === 'finance'
      ? Promise.resolve({ data: [] as Customer[], error: null })
      : supabase.from('customers').select('*').eq('created_by', order.salesperson_id).order('name'),
    profile.role === 'finance'
      ? Promise.resolve({ data: [] as CustomerGroup[], error: null })
      : supabase.from('customer_groups').select('*').order('name'),
    supabase.from('products').select('*').eq('is_active', true).order('name'),
  ])

  const loadError = customersResult.error || groupsResult.error || productsResult.error
  if (loadError) throw new Error(`订单基础数据读取失败：${loadError.message}`)

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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" className="h-8 w-8">
          <Link href={`/finance/performance/${id}`}><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">编辑 {order.order_number}</h1>
          <p className="text-sm text-muted-foreground">
            {profile.role === 'sales' || profile.role === 'supervisor'
              ? '订单提交后将锁定，驳回后可再次修改。'
              : '已完成订单的修正必须填写原因，并会写入审计记录。'}
          </p>
        </div>
      </div>
      <BusinessOrderForm
        profile={profile}
        customers={customers}
        customerGroups={(groupsResult.data ?? []) as CustomerGroup[]}
        products={(productsResult.data ?? []) as Product[]}
        initialOrder={order}
      />
    </div>
  )
}
