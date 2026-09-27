import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatCountryName } from '@/lib/country-flags'
import { formatCny } from '@/lib/finance'
import { createClient } from '@/lib/supabase/server'

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const [{ data: customer }, { data: orders }] = await Promise.all([
    supabase
      .from('customers')
      .select('id, name, company, country, contact_person, email, phone, address, city, state, postal_code, remarks, customer_groups(name)')
      .eq('id', id)
      .maybeSingle(),
    supabase
      .from('business_orders')
      .select('id, order_number, external_order_number, order_date, currency, total_amount, total_cny, status')
      .eq('customer_id', id)
      .is('voided_at', null)
      .order('order_date', { ascending: false }),
  ])
  if (!customer) notFound()

  const address = [customer.address, customer.city, customer.state, customer.postal_code]
    .filter(Boolean)
    .join(' · ')
  const details = [
    ['客户名称', customer.name],
    ['公司', customer.company],
    ['联系人', customer.contact_person],
    ['国家', formatCountryName(customer.country)],
    ['邮箱', customer.email],
    ['电话', customer.phone],
    ['地址', address || null],
    ['备注', customer.remarks],
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{customer.name}</h1>
          <p className="text-sm text-muted-foreground">客户下单明细</p>
        </div>
        <Button asChild variant="outline"><Link href="/customers">返回客户列表</Link></Button>
      </div>

      <Card>
        <CardHeader><CardTitle>客户信息</CardTitle></CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
            {details.map(([label, value]) => (
              <div key={label} className={label === '备注' ? 'sm:col-span-2 lg:col-span-4' : ''}>
                <dt className="text-sm text-muted-foreground">{label}</dt>
                <dd className="mt-1 whitespace-pre-wrap break-words font-medium">{value || '—'}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>订单明细</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead>下单日期</TableHead><TableHead>订单号</TableHead><TableHead>平台订单号</TableHead><TableHead>状态</TableHead><TableHead className="text-right">订单金额</TableHead></TableRow></TableHeader>
            <TableBody>
              {(orders ?? []).map((order) => <TableRow key={order.id}>
                <TableCell>{order.order_date}</TableCell>
                <TableCell><Link className="font-medium hover:underline" href={`/finance/daily-orders/${order.id}?fromCustomer=${id}`}>{order.order_number}</Link></TableCell>
                <TableCell>{order.external_order_number || '—'}</TableCell>
                <TableCell>{order.status}</TableCell>
                <TableCell className="text-right tabular-nums">{order.currency === 'CNY' ? formatCny(Number(order.total_amount)) : `${order.currency} ${Number(order.total_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}`}</TableCell>
              </TableRow>)}
              {(orders ?? []).length === 0 && <TableRow><TableCell colSpan={5} className="py-12 text-center text-muted-foreground">暂无历史订单</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
