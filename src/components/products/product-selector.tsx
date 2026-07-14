'use client'

import { useMemo, useState } from 'react'
import { Search, Plus, Minus, Trash2 } from 'lucide-react'
import { usePiCartStore } from '@/stores/pi-cart-store'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils'
import { calcLineTotal } from '@/lib/calc'
import type { Product } from '@/types'

export function ProductSelector({ products }: { products: Product[] }) {
  const [query, setQuery] = useState('')
  const { items, currency, addProduct, removeProduct, setQuantity, has } = usePiCartStore()

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return products
    return products.filter(
      (p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q),
    )
  }, [products, query])

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜索产品名称或 SKU"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
          {filtered.map((p) => {
            const disabled = items.length > 0 && p.currency !== currency
            const selected = has(p.id)
            return (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-md border p-3"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.sku} · {formatCurrency(p.unit_price, p.currency)} / {p.unit}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={selected ? 'secondary' : 'default'}
                  disabled={disabled || selected}
                  onClick={() => addProduct(p)}
                >
                  {selected ? '已加入' : disabled ? '币种不符' : '加入'}
                </Button>
              </div>
            )
          })}
          {filtered.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">没有匹配的产品</p>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">已选产品</h3>
          {items.length > 0 && <Badge variant="secondary">{currency}</Badge>}
        </div>

        {items.length === 0 ? (
          <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            从左侧选择产品加入 PI
          </p>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.product_id} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{item.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatCurrency(item.unit_price, item.currency)} / {item.unit}
                    </div>
                  </div>
                  <button
                    onClick={() => removeProduct(item.product_id)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      onClick={() => setQuantity(item.product_id, item.quantity - 1)}
                    >
                      <Minus className="h-3 w-3" />
                    </Button>
                    <Input
                      type="number"
                      min={1}
                      value={item.quantity}
                      onChange={(e) => setQuantity(item.product_id, Number(e.target.value))}
                      className="h-7 w-16 text-center"
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      onClick={() => setQuantity(item.product_id, item.quantity + 1)}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  </div>
                  <div className="font-medium">
                    {formatCurrency(calcLineTotal(item.unit_price, item.quantity), item.currency)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
