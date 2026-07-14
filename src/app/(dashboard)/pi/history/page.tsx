import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
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

interface PiRow {
  id: string
  pi_number: string
  customer_snapshot: CustomerSnapshot
  currency: string
  total: number
  status: 'active' | 'void'
  created_at: string
}

export default async function PiHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q } = await searchParams
  const supabase = await createClient()

  let query = supabase
    .from('proforma_invoices')
    .select('id, pi_number, customer_snapshot, currency, total, status, created_at')
    .order('created_at', { ascending: false })
    .limit(100)

  if (q?.trim()) {
    query = query.ilike('pi_number', `%${q.trim()}%`)
  }

  const { data } = await query
  const rows = (data ?? []) as PiRow[]

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">PI 历史</h1>

      <form className="flex gap-2" action="/pi/history">
        <Input name="q" defaultValue={q ?? ''} placeholder="按 PI 编号搜索…" className="max-w-xs" />
        <Button type="submit" variant="outline">
          搜索
        </Button>
      </form>

      <Card>
        <CardContent className="p-0">
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
              {rows.map((pi) => (
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
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    没有匹配的 PI
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
