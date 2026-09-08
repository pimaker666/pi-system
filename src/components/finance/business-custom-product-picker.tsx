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
import { listBusinessCustomProductsForCustomer } from '@/lib/actions/business-orders'
import { cn, formatCurrency } from '@/lib/utils'
import type { BusinessCustomProductListItem, CurrencyCode, Profile } from '@/types'
import { BusinessCustomProductDialog } from './business-custom-product-dialog'

interface BusinessCustomProductPickerProps {
  customerId: string | null
  orderCurrency: CurrencyCode
  profileRole: Profile['role']
  value: BusinessCustomProductListItem | null
  onChange: (product: BusinessCustomProductListItem | null) => void
  onCreated: (product: BusinessCustomProductListItem) => void
  allowCreate?: boolean
  disabled?: boolean
}

export function BusinessCustomProductPicker({
  customerId,
  orderCurrency,
  profileRole,
  value,
  onChange,
  onCreated,
  allowCreate = true,
  disabled = false,
}: BusinessCustomProductPickerProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [products, setProducts] = useState<BusinessCustomProductListItem[]>([])

  useEffect(() => {
    let active = true
    setProducts([])
    setOpen(false)
    if (!customerId) {
      setLoading(false)
      return () => { active = false }
    }

    setLoading(true)
    void listBusinessCustomProductsForCustomer(customerId)
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
  }, [customerId])

  const sorted = useMemo(
    () => [...products].sort((a, b) => a.name.localeCompare(b.name)),
    [products],
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
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled || !customerId || loading}
            className="min-w-0 flex-1 justify-between font-normal"
          >
            <span className={cn('truncate', !value && 'text-muted-foreground')}>
              {loading
                ? '正在加载定制产品…'
                : value
                  ? `${value.code} · ${value.name}（v${value.version_no}）`
                  : customerId
                    ? '选择客户定制产品…'
                    : '请先选择客户'}
            </span>
            {loading
              ? <Loader2 className="ml-2 h-4 w-4 shrink-0 animate-spin" />
              : <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command>
            <CommandInput placeholder="搜索名称、编码或规格…" />
            <CommandList>
              <CommandEmpty>该客户暂无可用定制产品</CommandEmpty>
              <CommandGroup>
                {sorted.map((product) => (
                  <CommandItem
                    key={product.version_id}
                    value={`${product.name} ${product.code} ${product.specification ?? ''}`}
                    onSelect={() => {
                      onChange(product)
                      setOpen(false)
                    }}
                    className="gap-2"
                  >
                    <Check
                      className={cn(
                        'h-4 w-4 shrink-0',
                        value?.version_id === product.version_id ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-medium">{product.name}</span>
                        <Badge variant={product.is_shared ? 'secondary' : 'outline'}>
                          {product.is_shared ? '共享' : '客户专属'}
                        </Badge>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {product.code} · v{product.version_no} · {product.unit} ·{' '}
                        {formatCurrency(Number(product.default_unit_price), product.default_currency)}
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
          customerId={customerId}
          defaultCurrency={orderCurrency}
          profileRole={profileRole}
          disabled={disabled}
          onCreated={handleCreated}
        />
      )}
    </div>
  )
}
