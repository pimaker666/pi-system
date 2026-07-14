import Link from 'next/link'
import { Package, Users, FileText, CalendarClock, FilePlus2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getDashboardStats } from '@/lib/dashboard-stats'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { CustomerSnapshot } from '@/types'

interface RecentPi {
  id: string
  pi_number: string
  customer_snapshot: CustomerSnapshot
  currency: string
  total: number
  status: 'active' | 'void'
  created_at: string
}

export default async function DashboardPage() {
  const stats = await getDashboardStats()
  const supabase = await createClient()
  const { data } = await supabase
    .from('proforma_invoices')
    .select('id, pi_number, customer_snapshot, currency, total, status, created_at')
    .order('created_at', { ascending: false })
    .limit(8)

  const recent = (data ?? []) as RecentPi[]

  const cards = [
    { label: '产品数', value: stats.productCount, icon: Package },
    { label: '客户数', value: stats.customerCount, icon: Users },
    { label: 'PI 总数', value: stats.piCount, icon: FileText },
    { label: '本月 PI', value: stats.monthPiCount, icon: CalendarClock },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">概览</h1>
        <Button asChild>
          <Link href="/pi/create">
            <FilePlus2 className="h-4 w-4" />
            开具 PI
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => {
          const Icon = c.icon
          return (
            <Card key={c.label}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {c.label}
                </CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{c.value}</div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">最近 PI</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              还没有 PI，点击右上角开具第一张
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PI 编号</TableHead>
                  <TableHead>客户</TableHead>
                  <TableHead className="text-right">金额</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>日期</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((pi) => (
                  <TableRow key={pi.id}>
                    <TableCell>
                      <Link href={`/pi/${pi.id}`} className="font-medium hover:underline">
                        {pi.pi_number}
                      </Link>
                    </TableCell>
                    <TableCell>{pi.customer_snapshot?.name ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(pi.total, pi.currency)}
                    </TableCell>
                    <TableCell>
                      {pi.status === 'void' ? (
                        <Badge variant="destructive">已作废</Badge>
                      ) : (
                        <Badge variant="success">有效</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(pi.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
