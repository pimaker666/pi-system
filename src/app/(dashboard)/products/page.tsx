import Link from 'next/link'
import Image from 'next/image'
import { Plus, Pencil } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getCurrentProfile } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils'
import type { Product } from '@/types'

export default async function ProductsPage() {
  const profile = await getCurrentProfile()
  const isAdmin = profile?.role === 'admin'
  const supabase = await createClient()
  const { data } = await supabase
    .from('products')
    .select('*')
    .order('created_at', { ascending: false })

  const products = (data ?? []) as Product[]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">产品库</h1>
        {isAdmin && (
          <Button asChild>
            <Link href="/products/new">
              <Plus className="h-4 w-4" />
              新增产品
            </Link>
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">图片</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>名称</TableHead>
                <TableHead className="text-right">单价</TableHead>
                <TableHead>状态</TableHead>
                {isAdmin && <TableHead className="text-right">操作</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="relative h-10 w-10 overflow-hidden rounded border bg-muted">
                      {p.image_url && (
                        <Image
                          src={p.image_url}
                          alt={p.name}
                          fill
                          className="object-cover"
                          sizes="40px"
                        />
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.sku}</TableCell>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(p.unit_price, p.currency)} / {p.unit}
                  </TableCell>
                  <TableCell>
                    {p.is_active ? (
                      <Badge variant="success">上架</Badge>
                    ) : (
                      <Badge variant="muted">下架</Badge>
                    )}
                  </TableCell>
                  {isAdmin && (
                    <TableCell className="text-right">
                      <Button asChild variant="ghost" size="icon" className="h-8 w-8">
                        <Link href={`/products/${p.id}/edit`}>
                          <Pencil className="h-4 w-4" />
                        </Link>
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {products.length === 0 && (
                <TableRow>
                  <TableCell colSpan={isAdmin ? 6 : 5} className="py-10 text-center text-muted-foreground">
                    还没有产品
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
