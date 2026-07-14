import Link from 'next/link'
import { UsersRound } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { NewCustomerButton } from '@/components/customers/new-customer-button'
import { CustomerRowActions } from '@/components/customers/customer-row-actions'
import type { Customer, CustomerGroup } from '@/types'

interface CustomerWithGroup extends Customer {
  customer_groups: { name: string } | null
}

export default async function CustomersPage() {
  const supabase = await createClient()

  const [{ data: customerData }, { data: groupData }] = await Promise.all([
    supabase
      .from('customers')
      .select('*, customer_groups(name)')
      .order('created_at', { ascending: false }),
    supabase.from('customer_groups').select('*').order('name'),
  ])

  const customers = (customerData ?? []) as CustomerWithGroup[]
  const groups = (groupData ?? []) as CustomerGroup[]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">客户</h1>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/customers/groups">
              <UsersRound className="h-4 w-4" />
              管理分组
            </Link>
          </Button>
          <NewCustomerButton groups={groups} />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>客户</TableHead>
                <TableHead>公司</TableHead>
                <TableHead>国家</TableHead>
                <TableHead>分组</TableHead>
                <TableHead>联系方式</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>{c.company ?? '—'}</TableCell>
                  <TableCell>{c.country ?? '—'}</TableCell>
                  <TableCell>
                    {c.customer_groups ? (
                      <Badge variant="secondary">{c.customer_groups.name}</Badge>
                    ) : (
                      <span className="text-muted-foreground">未分组</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {c.email ?? c.phone ?? '—'}
                  </TableCell>
                  <TableCell>
                    <CustomerRowActions customer={c} groups={groups} />
                  </TableCell>
                </TableRow>
              ))}
              {customers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    还没有客户
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
