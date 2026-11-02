'use client'

import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const OPTIONS = [
  { value: 'fully_shipped', label: '全部发货' },
  { value: 'partially_shipped', label: '部分发货' },
  { value: 'unshipped', label: '未发货' },
] as const

/**
 * 发货状态多选：勾选只更新本地状态，提交仍走「应用筛选」。
 * 用 Popover（portal 到 body）而不是 <details> 绝对定位，避免被筛选表单的 overflow-hidden 裁剪。
 */
export function FulfillmentStatusSelect({
  defaultSelected,
  triggerClassName,
}: {
  defaultSelected: readonly string[]
  triggerClassName: string
}) {
  const [value, setValue] = React.useState<string[]>([...defaultSelected])
  React.useEffect(() => {
    setValue([...defaultSelected])
  }, [defaultSelected])

  const selectedSet = new Set(value)

  function toggle(status: string) {
    setValue((current) => {
      const next = new Set(current)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return OPTIONS.filter((option) => next.has(option.value)).map((option) => option.value)
    })
  }

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn('flex items-center justify-between gap-2 text-left', triggerClassName)}
          >
            <span className="truncate">
              {value.length > 0 ? `发货状态 (${value.length})` : '全部发货状态'}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-44 p-1.5" sideOffset={4}>
          {OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={selectedSet.has(option.value)}
                onChange={() => toggle(option.value)}
                className="h-4 w-4 shrink-0 accent-primary"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </PopoverContent>
      </Popover>
      {OPTIONS.filter((option) => selectedSet.has(option.value)).map((option) => (
        <input
          key={option.value}
          type="hidden"
          name="fulfillmentStatuses"
          value={option.value}
        />
      ))}
    </>
  )
}
