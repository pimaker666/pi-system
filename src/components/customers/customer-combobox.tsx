'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronsUpDown, Plus, X } from 'lucide-react'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CustomerFormFields } from './customer-form-fields'
import type { Customer, CustomerGroup } from '@/types'

interface CustomerComboboxProps {
  customers: Customer[]
  groups: CustomerGroup[]
  value: Customer | null
  onChange: (customer: Customer | null) => void
  allowCreate?: boolean
  allowClear?: boolean
}

export function CustomerCombobox({
  customers,
  groups,
  value,
  onChange,
  allowCreate = true,
  allowClear = false,
}: CustomerComboboxProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [localCustomers, setLocalCustomers] = useState(customers)

  useEffect(() => setLocalCustomers(customers), [customers])

  const sorted = useMemo(
    () => [...localCustomers].sort((a, b) => a.name.localeCompare(b.name)),
    [localCustomers],
  )

  return (
    <div className="flex gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="flex-1 justify-between font-normal"
          >
            {value ? (
              <span className="truncate">
                {value.name}
                {value.company ? ` · ${value.company}` : ''}
              </span>
            ) : (
              <span className="text-muted-foreground">选择客户…</span>
            )}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command>
            <CommandInput placeholder="搜索客户名称/公司…" />
            <CommandList>
              <CommandEmpty>未找到客户</CommandEmpty>
              <CommandGroup>
                {sorted.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={`${c.name} ${c.company ?? ''}`}
                    onSelect={() => {
                      onChange(c)
                      setOpen(false)
                    }}
                  >
                    <Check
                      className={cn(
                        'mr-2 h-4 w-4',
                        value?.id === c.id ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="truncate">
                      {c.name}
                      {c.company ? ` · ${c.company}` : ''}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {allowClear && value && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="清除客户"
          onClick={() => onChange(null)}
        >
          <X className="h-4 w-4" />
        </Button>
      )}

      {allowCreate && (
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <Button type="button" variant="outline" size="icon" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
          </Button>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>新增客户</DialogTitle>
            </DialogHeader>
            <CustomerFormFields
              groups={groups}
              onSuccess={(_id, createdCustomer) => {
                if (createdCustomer) {
                  setLocalCustomers((current) => [
                    createdCustomer,
                    ...current.filter((customer) => customer.id !== createdCustomer.id),
                  ])
                  onChange(createdCustomer)
                }
                setCreateOpen(false)
                router.refresh()
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
