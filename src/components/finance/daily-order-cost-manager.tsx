'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Download, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { updateDailyOrderCostOverride } from '@/lib/actions/finance'
import { SHIPPING_LABELS } from '@/lib/daily-orders'
import type { DailyOrderProductCost } from '@/types'

function costText(value: number) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value)
}

function CostEditor({ row }: { row: DailyOrderProductCost }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const initialValue = row.cost == null ? '' : String(row.cost)
  const [draft, setDraft] = useState(initialValue)
  const normalized = draft.trim()
  const unchanged = normalized === initialValue

  useEffect(() => {
    setDraft(initialValue)
  }, [initialValue])

  function save() {
    const cost = normalized === '' ? null : Number(normalized)
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) {
      toast.error('成本必须是非负数字')
      return
    }

    startTransition(async () => {
      const result = await updateDailyOrderCostOverride({
        daily_order_id: row.daily_order_id,
        cost,
      })
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '成本保存失败')
        return
      }
      toast.success(cost === null ? '已恢复产品库成本' : '订单行成本已保存')
      router.refresh()
    })
  }

  return (
    <div className="flex min-w-44 items-center gap-2">
      <Input
        value={draft}
        type="number"
        min={0}
        step="0.0001"
        disabled={pending}
        placeholder={row.shipping_category === 'custom' ? '定制订单留空' : '未匹配成本'}
        title="留空保存可恢复产品库自动匹配成本"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !pending && !unchanged) {
            event.preventDefault()
            save()
          }
        }}
        className="h-8"
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8 shrink-0"
        disabled={pending || unchanged}
        onClick={save}
        aria-label={`保存订单 ${row.order_number} 的产品成本`}
        title="保存；留空则恢复产品库成本"
      >
        <Save className="h-4 w-4" />
      </Button>
      {row.cost_overridden && <span className="whitespace-nowrap text-xs text-muted-foreground">已修改</span>}
    </div>
  )
}

export function DailyOrderCostManager({ rows }: { rows: DailyOrderProductCost[] }) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">已发货每日订单产品成本</h2>
          <p className="text-sm text-muted-foreground">
            自动显示发货日期不晚于今天的订单。普通产品匹配产品库财务资料；定制或未匹配产品留空。
          </p>
        </div>
        <Button asChild variant="outline">
          <a download href="/api/finance/costs/export/xlsx">
            <Download className="h-4 w-4" />
            导出全部成本
          </a>
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <Table className="min-w-[1800px]">
          <TableHeader>
            <TableRow>
              <TableHead>发货日期</TableHead>
              <TableHead>订单号</TableHead>
              <TableHead>店铺</TableHead>
              <TableHead>业务员</TableHead>
              <TableHead>销售产品/SKU</TableHead>
              <TableHead>发货分类</TableHead>
              <TableHead className="text-right">数量</TableHead>
              <TableHead>财务编号</TableHead>
              <TableHead>产品名称</TableHead>
              <TableHead>成本</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.daily_order_id}>
                <TableCell>{row.shipping_date}</TableCell>
                <TableCell>
                  <div className="font-medium">{row.order_number}</div>
                  <div className="text-xs text-muted-foreground">下单 {row.order_date}</div>
                </TableCell>
                <TableCell>{row.shop_name}</TableCell>
                <TableCell>{row.salesperson_name}</TableCell>
                <TableCell>
                  <div>{row.sales_product_name}</div>
                  <div className="text-xs text-muted-foreground">{row.sales_product_sku}</div>
                </TableCell>
                <TableCell>{SHIPPING_LABELS[row.shipping_category]}</TableCell>
                <TableCell className="text-right tabular-nums">{costText(row.quantity)}</TableCell>
                <TableCell>{row.financial_number || '—'}</TableCell>
                <TableCell>{row.financial_product_name || '—'}</TableCell>
                <TableCell><CostEditor row={row} /></TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="py-12 text-center text-muted-foreground">
                  暂无已发货的每日订单
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}
