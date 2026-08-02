'use client'

import { useState } from 'react'
import { Download, FileText, FileSpreadsheet, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'

interface PiDownloadMenuProps {
  id: string
  /** Compact icon-only trigger for table rows. */
  compact?: boolean
  className?: string
}

/**
 * Download menu offering PDF (default) or Excel. Uses same-origin anchors so
 * the browser saves each file under the server-provided attachment filename
 * (客户名PI日期流水号).
 */
export function PiDownloadMenu({ id, compact = false, className }: PiDownloadMenuProps) {
  const [open, setOpen] = useState(false)

  const item = (href: string, label: string, hint: string, Icon: typeof FileText) => (
    <a
      href={href}
      onClick={() => setOpen(false)}
      className="flex items-start gap-3 rounded-md px-2 py-2 text-sm hover:bg-accent"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
    </a>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {compact ? (
          <Button variant="ghost" size="icon" className={cn('h-8 w-8', className)} title="下载">
            <Download className="h-4 w-4" />
          </Button>
        ) : (
          <Button variant="outline" className={className}>
            <Download className="h-4 w-4" />
            下载
            <ChevronDown className="h-4 w-4 opacity-60" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        {item(`/api/pi/${id}/pdf`, 'PDF', '默认格式，适合打印/发送', FileText)}
        {item(`/api/pi/${id}/xlsx`, 'Excel', '完整 PI 电子表格', FileSpreadsheet)}
      </PopoverContent>
    </Popover>
  )
}
