import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PiActions } from '@/components/pi/pi-actions'
import { PiPreview } from '@/components/pi/pi-preview'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { ProformaInvoiceWithItems } from '@/types'

export default async function PiDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data: piData } = await supabase
    .from('proforma_invoices')
    .select('*, pi_items(*)')
    .eq('id', id)
    .single()

  if (!piData) notFound()
  const pi = piData as ProformaInvoiceWithItems
  const c = pi.customer_snapshot

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon" className="h-8 w-8">
            <Link href="/pi/history">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">{pi.pi_number}</h1>
              {pi.status === 'void' ? (
                <Badge variant="destructive">已作废</Badge>
              ) : (
                <Badge variant="success">有效</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{formatDate(pi.created_at, true)}</p>
          </div>
        </div>
        <PiActions id={pi.id} status={pi.status} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">客户信息</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div className="font-medium">{c.name}</div>
              {c.company && <div>{c.company}</div>}
              {c.contact_person && <div>联系人：{c.contact_person}</div>}
              {c.address && <div className="text-muted-foreground">{c.address}</div>}
              {c.country && <div className="text-muted-foreground">{c.country}</div>}
              {c.email && <div className="text-muted-foreground">{c.email}</div>}
              {c.phone && <div className="text-muted-foreground">{c.phone}</div>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">金额</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">小计</span>
                <span>{formatCurrency(pi.subtotal, pi.currency)}</span>
              </div>
              {pi.discount > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">折扣</span>
                  <span>-{formatCurrency(pi.discount, pi.currency)}</span>
                </div>
              )}
              {pi.tax_rate > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">税 ({pi.tax_rate}%)</span>
                  <span>{formatCurrency(pi.tax_amount, pi.currency)}</span>
                </div>
              )}
              {pi.shipping_fee > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">运费</span>
                  <span>{formatCurrency(pi.shipping_fee, pi.currency)}</span>
                </div>
              )}
              <div className="flex justify-between border-t pt-2 text-base font-semibold">
                <span>总计</span>
                <span>{formatCurrency(pi.total, pi.currency)}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">PDF 预览</CardTitle>
          </CardHeader>
          <CardContent>
            <PiPreview id={pi.id} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
