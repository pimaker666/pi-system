'use client'

import { useMemo, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { PaymentAccount } from '@/types'

interface PaymentAccountComboboxProps {
  accounts: PaymentAccount[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
}

export function PaymentAccountCombobox({
  accounts,
  value,
  onChange,
  placeholder = '选择或填写收款账户…',
  disabled = false,
}: PaymentAccountComboboxProps) {
  const [open, setOpen] = useState(false)

  const sorted = useMemo(
    () => [...accounts].sort((a, b) => a.name.localeCompare(b.name)),
    [accounts],
  )

  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          maxLength={200}
          disabled={disabled}
          className="pr-10"
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 h-full px-3 text-muted-foreground hover:text-foreground"
              disabled={disabled}
              aria-label="展开收款账户选项"
            >
              <ChevronsUpDown className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
            <Command>
              <CommandInput placeholder="搜索收款账户…" />
              <CommandList>
                <CommandEmpty>未找到收款账户</CommandEmpty>
                <CommandGroup>
                  {sorted.map((account) => (
                    <CommandItem
                      key={account.id}
                      value={account.name}
                      onSelect={() => {
                        onChange(account.name)
                        setOpen(false)
                      }}
                    >
                      <Check
                        className={cn(
                          'mr-2 h-4 w-4',
                          value === account.name ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      <span className="truncate">{account.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
