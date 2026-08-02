import { notFound } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { ArrowLeft, Download, ImageIcon } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { formatDate } from '@/lib/utils'
import { toImageSrc } from '@/lib/supabase/image'
import type { WeightCalculationWithItems, WeightCalcItem } from '@/types'

/** KG string with up to 3 decimals from a gram total. */
function gToKg(grams: number): string {
  return (Number(grams) / 1000).toLocaleString('en-US', {
    maximumFractionDigits: 3,
  })
}

function fmtNum(n: number): string {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/**
 * Read-only preview of a saved weight calculation. Reached by clicking a
 * calc number in 克重历史. Mirrors the PI detail page pattern (back link + meta
 * card + content) but renders the calculation table as HTML rather than a PDF,
 * since weight calcs export to Excel. RLS scopes the row to its owner/admin.
 */
export default async function WeightCalcDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data } = await supabase
    .from('weight_calculations')
    .select('*, weight_calc_items(*), source_pi:proforma_invoices(pi_number)')
    .eq('id', id)
    .single()

  if (!data) notFound()

  const calc = data as WeightCalculationWithItems & {
    source_pi: { pi_number: string } | null
  }
  const items = [...(calc.weight_calc_items ?? [])].sort(
    (a, b) => a.sort_order - b.sort_order,
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon" className="h-8 w-8">
            <Link href="/pi/history?view=weight">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold">{calc.calc_number}</h1>
            <p className="text-sm text-muted-foreground">
              {formatDate(calc.created_at, true)}
            </p>
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <a href={`/api/weight-calc/${calc.id}/xlsx`}>
            <Download className="mr-1 h-4 w-4" />
            下载 Excel
          </a>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">计算单信息</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <span className="text-muted-foreground">标题：</span>
            {calc.title || '—'}
          </div>
          {calc.source_pi?.pi_number && (
            <div>
              <span className="text-muted-foreground">来源 PI：</span>
              {calc.source_pi.pi_number}
            </div>
          )}
          <div>
            <span className="text-muted-foreground">总数量：</span>
            <span className="font-medium">{fmtNum(calc.total_quantity)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">总重量：</span>
            <span className="font-medium">
              {gToKg(calc.total_weight_g)} KG
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">重量计算表</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 text-center">#</TableHead>
                  <TableHead>产品</TableHead>
                  <TableHead className="w-28 text-right">克重 (g)</TableHead>
                  <TableHead className="w-24 text-right">数量</TableHead>
                  <TableHead className="w-32 text-right">总重量 (KG)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item: WeightCalcItem, index: number) => (
                  <TableRow key={item.id}>
                    <TableCell className="text-center text-muted-foreground">
                      {index + 1}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded border bg-muted">
                          {item.image_url ? (
                            <Image
                              src={toImageSrc(item.image_url)}
                              alt={item.name}
                              fill
                              className="object-cover"
                              sizes="40px"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                              <ImageIcon className="h-4 w-4" />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {item.name}
                          </div>
                          {item.sku && (
                            <div className="truncate text-xs text-muted-foreground">
                              {item.sku}
                            </div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtNum(item.weight_g)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtNum(item.quantity)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {gToKg(item.line_weight_g)}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/50 font-semibold">
                  <TableCell />
                  <TableCell className="text-right">合计</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums">
                    {fmtNum(calc.total_quantity)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {gToKg(calc.total_weight_g)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
