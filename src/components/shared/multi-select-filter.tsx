'use client'

import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface MultiSelectFilterOption {
  value: string
  label: string
}

interface MultiSelectFilterProps {
  /** 未选中任何项时的占位文案，如「全部分组」 */
  allLabel: string
  options: MultiSelectFilterOption[]
  selected: string[]
  onChange: (values: string[]) => void
  className?: string
}

/** 筛选栏多选下拉：点选即时生效，支持全选 / 反选 / 清空，弹层保持展开便于连续勾选。 */
export function MultiSelectFilter({
  allLabel,
  options,
  selected,
  onChange,
  className,
}: MultiSelectFilterProps) {
  const [open, setOpen] = React.useState(false)
  // 乐观选中：勾选立即本地生效（导航是服务端往返，等 URL 回传才显示勾选会显得卡顿）；
  // 服务端渲染带新 URL 回来后丢弃本地态，以 URL 为准。
  const [optimistic, setOptimistic] = React.useState<string[] | null>(null)
  React.useEffect(() => {
    setOptimistic(null)
  }, [selected])
  const current = optimistic ?? selected
  const selectedSet = new Set(current)
  const matched = options.filter((option) => selectedSet.has(option.value))

  function apply(next: Set<string>) {
    const values = options.filter((option) => next.has(option.value)).map((option) => option.value)
    setOptimistic(values)
    onChange(values)
  }

  function toggle(value: string) {
    const next = new Set(selectedSet)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    apply(next)
  }

  const triggerText =
    matched.length === 0
      ? allLabel
      : matched.length === 1
        ? matched[0].label
        : `${allLabel.replace(/^全部/, '')}（${matched.length}）`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-10 items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm hover:bg-muted/50',
            matched.length > 0 && 'border-primary/50',
            className,
          )}
        >
          <span className="truncate">{triggerText}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <div className="flex items-center gap-1 border-b px-2 py-1.5 text-xs">
          <button
            type="button"
            className="rounded px-2 py-1 hover:bg-muted"
            onClick={() => apply(new Set(options.map((option) => option.value)))}
          >
            全选
          </button>
          <button
            type="button"
            className="rounded px-2 py-1 hover:bg-muted"
            onClick={() => apply(new Set(options.filter((option) => !selectedSet.has(option.value)).map((option) => option.value)))}
          >
            反选
          </button>
          <button
            type="button"
            className="ml-auto rounded px-2 py-1 text-muted-foreground hover:bg-muted"
            onClick={() => apply(new Set())}
          >
            清空
          </button>
        </div>
        <div className="max-h-64 overflow-auto p-1">
          {options.map((option) => (
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
              <span className="truncate">{option.label}</span>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
