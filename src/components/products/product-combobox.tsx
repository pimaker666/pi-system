'use client'

import { useMemo, useState } from 'react'
import Image from 'next/image'
import { Check, ChevronsUpDown, ImageIcon } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'
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
import { toImageSrc } from '@/lib/supabase/image'
import type { CurrencyCode } from '@/types'

export interface ProductComboboxOption {
  id: string
  name: string
  sku: string
  image_url?: string | null
  unit_price?: number | null
  currency?: CurrencyCode | null
  unit?: string | null
}

interface ProductComboboxProps {
  products: ProductComboboxOption[]
  value: string
  onChange: (id: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
}

/** 32px product thumbnail used inside the dropdown list and trigger. */
function Thumb({ src, alt }: { src: string | null | undefined; alt: string }) {
  const imgSrc = toImageSrc(src)
  return (
    <div className="relative h-8 w-8 shrink-0 overflow-hidden rounded border bg-muted">
      {imgSrc ? (
        <Image src={imgSrc} alt={alt} fill className="object-cover" sizes="32px" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <ImageIcon className="h-4 w-4" />
        </div>
      )}
    </div>
  )
}

export function ProductCombobox({
  products,
  value,
  onChange,
  placeholder = '选择产品…',
  disabled = false,
  className,
}: ProductComboboxProps) {
  const [open, setOpen] = useState(false)
  const selected = useMemo(
    () => products.find((product) => product.id === value) ?? null,
    [products, value],
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn('justify-between font-normal', className)}
        >
          {selected ? (
            <span className="flex min-w-0 items-center gap-2">
              <Thumb src={selected.image_url} alt={selected.name} />
              <span className="truncate">
                {selected.sku} · {selected.name}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="搜索产品名称或 SKU…" />
          <CommandList>
            <CommandEmpty>未找到产品</CommandEmpty>
            <CommandGroup>
              {products.map((product) => {
                const hasPrice =
                  product.unit_price != null && product.currency != null
                return (
                  <CommandItem
                    key={product.id}
                    value={`${product.name} ${product.sku}`}
                    onSelect={() => {
                      onChange(product.id)
                      setOpen(false)
                    }}
                    className="gap-2"
                  >
                    <Check
                      className={cn(
                        'h-4 w-4 shrink-0',
                        value === product.id ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <Thumb src={product.image_url} alt={product.name} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{product.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {product.sku}
                        {hasPrice
                          ? ` · ${formatCurrency(Number(product.unit_price), product.currency as CurrencyCode)}`
                          : ''}
                        {product.unit ? ` / ${product.unit}` : ''}
                      </div>
                    </div>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
