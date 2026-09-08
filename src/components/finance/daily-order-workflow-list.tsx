'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Eye, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { WORKFLOW_STATUS_LABELS, WORKFLOW_STATUS_VARIANTS } from '@/lib/daily-orders'
import { displayProfileName, formatDate } from '@/lib/utils'
import type { DailyOrderWorkflowStatus } from '@/types'
import type { DailyOrderWorkflowSummary } from '@/lib/daily-orders-server'

export interface DailyOrderWorkflowListProps {
  workflows: DailyOrderWorkflowSummary[]
}

export function DailyOrderWorkflowList({ workflows }: DailyOrderWorkflowListProps) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | DailyOrderWorkflowStatus>('all')

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    return workflows.filter((workflow) => {
      if (status !== 'all' && workflow.status !== status) return false
      if (!normalized) return true
      return [
        workflow.order_number,
        displayProfileName(
          workflow.salesperson,
          workflow.salesperson_display_name_snapshot || workflow.salesperson_name_snapshot,
        ),
        workflow.customer_name_snapshot ?? '',
      ]
        .join(' ')
        .toLocaleLowerCase('zh-CN')
        .includes(normalized)
    })
  }, [workflows, query, status])

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索订单号、业务员或客户"
            className="pl-9"
          />
        </div>
        <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {Object.entries(WORKFLOW_STATUS_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>订单号</TableHead>
              <TableHead>业务员</TableHead>
              <TableHead>客户</TableHead>
              <TableHead className="text-right">明细行</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="whitespace-nowrap">更新时间</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((workflow) => (
              <TableRow key={workflow.id}>
                <TableCell>
                  <Link
                    href={`/finance/performance/orders/${workflow.id}`}
                    className="font-medium hover:underline"
                  >
                    {workflow.order_number}
                  </Link>
                </TableCell>
                <TableCell>
                  {displayProfileName(
                    workflow.salesperson,
                    workflow.salesperson_display_name_snapshot || workflow.salesperson_name_snapshot,
                  )}
                </TableCell>
                <TableCell>{workflow.customer_name_snapshot || '—'}</TableCell>
                <TableCell className="text-right">{workflow.order_line_count}</TableCell>
                <TableCell>
                  <Badge variant={WORKFLOW_STATUS_VARIANTS[workflow.status]}>
                    {WORKFLOW_STATUS_LABELS[workflow.status]}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                  {formatDate(workflow.updated_at)}
                </TableCell>
                <TableCell>
                  <Button asChild variant="ghost" size="icon">
                    <Link
                      href={`/finance/performance/orders/${workflow.id}`}
                      aria-label="查看订单工作流"
                    >
                      <Eye className="h-4 w-4" />
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                  暂无符合条件的订单
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
