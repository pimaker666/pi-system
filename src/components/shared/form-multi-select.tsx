'use client'

import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export type FormMultiSelectOption = {
  value: string
  label: string
}

/**
 * 表单内多选筛选：勾选只更新本地状态，提交仍走外层表单的「应用筛选」。
 * 用 Popover（portal 到 body）而不是绝对定位面板，避免被筛选表单的 overflow-hidden 裁剪。
 * 选中项通过同名 hidden input 提交，与后端数组参数一一对应。
 */
export function FormMultiSelect({
  name,
  label,
  allLabel,
  options,
  defaultSelected,
  triggerClassName,
  panelClassName,
  emptyValue,
}: {
  name: string
  label: string
  allLabel: string
  options: readonly FormMultiSelectOption[]
  defaultSelected: readonly string[]
  triggerClassName: string
  panelClassName?: string
  /** 清空全部勾选时提交的哨兵值，用于和「参数缺失」区分（如 all = 不限制）。 */
  emptyValue?: string
}) {
  const [value, setValue] = React.useState<string[]>([...defaultSelected])
  React.useEffect(() => {
    setValue([...defaultSelected])
  }, [defaultSelected])

  const selectedSet = new Set(value)
  const selectedLabels = options
    .filter((option) => selectedSet.has(option.value))
    .map((option) => option.label)
  const triggerText =
    selectedLabels.length === 0
      ? allLabel
      : selectedLabels.length === 1
        ? selectedLabels[0]
        : `${label}（${selectedLabels.length}）`

  function toggle(optionValue: string) {
    setValue((current) => {
      const next = new Set(current)
      if (next.has(optionValue)) next.delete(optionValue)
      else next.add(optionValue)
      return options.filter((option) => next.has(option.value)).map((option) => option.value)
    })
  }

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={selectedLabels.length > 1 ? selectedLabels.join('、') : undefined}
            className={cn('flex items-center justify-between gap-2 text-left', triggerClassName)}
          >
            <span className="truncate">{triggerText}</span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className={cn('w-56 p-1.5', panelClassName)} sideOffset={4}>
          <div className="flex items-center justify-between gap-2 border-b px-2 pb-1.5 text-xs">
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => setValue(options.map((option) => option.value))}
            >
              全选
            </button>
            <button
              type="button"
              className="text-muted-foreground hover:underline"
              onClick={() => setValue([])}
            >
              清空
            </button>
          </div>
          <div className="max-h-72 space-y-0.5 overflow-y-auto pt-1">
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
      {value.length === 0 && emptyValue ? (
        <input type="hidden" name={name} value={emptyValue} />
      ) : (
        value.map((selected) => (
          <input key={selected} type="hidden" name={name} value={selected} />
        ))
      )}
    </>
  )
}
