'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronsUpDown, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { listBusinessCustomProducts } from '@/lib/actions/business-orders'
import { cn, formatCurrency } from '@/lib/utils'
import type {
  BusinessCustomProductListItem,
  CurrencyCode,
  ProductGroup,
} from '@/types'
import { BusinessCustomProductDialog } from './business-custom-product-dialog'

const ALL = '__all__'

interface BusinessCustomProductPickerProps {
  orderCurrency: CurrencyCode
  productGroups: ProductGroup[]
  value: BusinessCustomProductListItem | null
  onChange: (product: BusinessCustomProductListItem | null) => void
  onCreated: (product: BusinessCustomProductListItem) => void
  allowCreate?: boolean
  disabled?: boolean
}

export function BusinessCustomProductPicker({
  orderCurrency,
  productGroups,
  value,
  onChange,
  onCreated,
  allowCreate = true,
  disabled = false,
}: BusinessCustomProductPickerProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [products, setProducts] = useState<BusinessCustomProductListItem[]>([])
  const [groupFilter, setGroupFilter] = useState(ALL)

  useEffect(() => {
    let active = true
    setLoading(true)
    void listBusinessCustomProducts()
      .then((result) => {
        if (!active) return
        if (!result.ok) {
          toast.error(result.error ?? '读取定制产品失败')
          return
        }
        setProducts((result.data ?? []).filter((product) => !product.is_archived))
      })
      .catch(() => {
        if (active) toast.error('读取定制产品失败，请稍后重试')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  const latestProducts = useMemo(() => {
    const latest = new Map<string, BusinessCustomProductListItem>()
    for (const product of products) {
      const current = latest.get(product.custom_product_id)
      if (!current || product.version_no > current.version_no) {
        latest.set(product.custom_product_id, product)
      }
    }
    return [...latest.values()]
  }, [products])

  const filteredProducts = useMemo(
    () => latestProducts
      .filter((product) => groupFilter === ALL || product.product_group_id === groupFilter)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [groupFilter, latestProducts],
  )

  function handleCreated(product: BusinessCustomProductListItem) {
    setProducts((current) => [
      product,
      ...current.filter((item) => item.version_id !== product.version_id),
    ])
    onChange(product)
    onCreated(product)
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" role="combobox" aria-expanded={open} disabled={disabled || loading} className="min-w-0 flex-1 justify-between font-normal">
            <span className={cn('truncate', !value && 'text-muted-foreground')}>
              {loading
                ? '正在加载定制产品…'
                : value
                  ? `${[value.code, value.name].filter(Boolean).join(' · ')}（v${value.version_no}）`
                  : '选择定制产品…'}
            </span>
            {loading ? <Loader2 className="ml-2 h-4 w-4 shrink-0 animate-spin" /> : <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <div className="border-b p-2">
            <Select value={groupFilter} onValueChange={setGroupFilter}>
              <SelectTrigger aria-label="按产品分组筛选"><SelectValue placeholder="全部产品分组" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部产品分组</SelectItem>
                {productGroups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Command>
            <CommandInput placeholder="搜索名称、编码或规格…" />
            <CommandList>
              <CommandEmpty>暂无可用定制产品</CommandEmpty>
              <CommandGroup>
                {filteredProducts.map((product) => (
                  <CommandItem key={product.version_id} value={`${product.name} ${product.code} ${product.specification ?? ''} ${product.product_group_name ?? ''}`} onSelect={() => { onChange(product); setOpen(false) }} className="gap-2">
                    <Check className={cn('h-4 w-4 shrink-0', value?.version_id === product.version_id ? 'opacity-100' : 'opacity-0')} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-medium">{product.name}</span>
                        {product.product_group_name && <Badge variant="outline">{product.product_group_name}</Badge>}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {[
                          product.code,
                          `v${product.version_no}`,
                          product.unit,
                          formatCurrency(Number(product.default_unit_price), product.default_currency),
                        ].filter(Boolean).join(' · ')}
                        {product.default_currency !== orderCurrency ? `（订单币种 ${orderCurrency}，不自动换算）` : ''}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {allowCreate && (
        <BusinessCustomProductDialog
          defaultCurrency={orderCurrency}
          productGroups={productGroups}
          disabled={disabled}
          onCreated={handleCreated}
        />
      )}
    </div>
  )
}
