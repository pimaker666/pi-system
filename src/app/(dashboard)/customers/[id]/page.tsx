import Image from 'next/image'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { CustomerDetailEditButton } from '@/components/customers/customer-detail-edit-button'
import { CustomerOrdersTable, type CustomerOrderRow } from '@/components/customers/customer-orders-table'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCountryName } from '@/lib/country-flags'
import { toImageSrc } from '@/lib/supabase/image'
import { createClient } from '@/lib/supabase/server'
import type { Customer, CustomerGroup } from '@/types'

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const [{ data: customer }, { data: groups }, { data: orders }] = await Promise.all([
    supabase.from('customers').select('*').eq('id', id).maybeSingle(),
    supabase.from('customer_groups').select('*').order('name'),
    supabase
      .from('business_orders')
      .select('id, order_number, external_order_number, order_date, currency, total_amount, shipping_fee, status')
      .eq('customer_id', id)
      .is('voided_at', null)
      .order('order_date', { ascending: false }),
  ])
  if (!customer) notFound()

  const orderIds = (orders ?? []).map((order) => order.id)
  const { data: orderItems } = orderIds.length
    ? await supabase
        .from('business_order_items')
        .select('id, order_id, name_snapshot, quantity, unit_price, sales_total_amount, line_amount, logistics_fee_amount, sort_order')
        .in('order_id', orderIds)
        .order('sort_order')
    : { data: [] as never[] }
  const itemsByOrder = new Map<string, typeof orderItems>()
  for (const item of orderItems ?? []) {
    const list = itemsByOrder.get(item.order_id) ?? []
    list.push(item)
    itemsByOrder.set(item.order_id, list)
  }
  const orderRows: CustomerOrderRow[] = (orders ?? []).map((order) => ({
    ...order,
    items: itemsByOrder.get(order.id) ?? [],
  }))

  const customerRecord = customer as Customer
  const logoUrls = customerRecord.logo_urls.length
    ? customerRecord.logo_urls
    : customerRecord.logo_url
      ? [customerRecord.logo_url]
      : []
  const address = [customerRecord.address, customerRecord.city, customerRecord.state, customerRecord.postal_code]
    .filter(Boolean)
    .join(' · ')
  const details = [
    ['客户名称', customerRecord.name],
    ['公司', customerRecord.company],
    ['品牌名字', customerRecord.brand_name],
    ['联系人', customerRecord.contact_person],
    ['国家', formatCountryName(customerRecord.country)],
    ['邮箱', customerRecord.email],
    ['电话', customerRecord.phone],
    ['地址', address || null],
    ['备注', customerRecord.remarks],
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{customerRecord.name}</h1>
          <p className="text-sm text-muted-foreground">客户下单明细</p>
        </div>
        <Button asChild variant="outline"><Link href="/customers">返回客户列表</Link></Button>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>客户信息</CardTitle>
          <CustomerDetailEditButton customer={customerRecord} groups={(groups ?? []) as CustomerGroup[]} />
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-5 sm:flex-row">
            {logoUrls.length > 0 && (
              <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3">
                {logoUrls.map((url, index) => (
                  <div key={url} className="relative h-20 w-20 overflow-hidden rounded-md border bg-muted">
                    <Image src={toImageSrc(url)} alt={`${customerRecord.name} Logo ${index + 1}`} fill className="object-contain p-2" sizes="80px" />
                  </div>
                ))}
              </div>
            )}
            <dl className="grid flex-1 gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
              {details.map(([label, value]) => (
                <div key={label} className={label === '备注' ? 'sm:col-span-2 lg:col-span-4' : ''}>
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd className="mt-1 whitespace-pre-wrap break-words font-medium">{value || '—'}</dd>
                </div>
              ))}
            </dl>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>订单明细</CardTitle></CardHeader>
        <CardContent className="p-0">
          <CustomerOrdersTable orders={orderRows} fromCustomerId={id} />
        </CardContent>
      </Card>
    </div>
  )
}
