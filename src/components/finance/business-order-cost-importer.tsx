'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { updateBusinessOrderItemCostOverride } from '@/lib/actions/finance'
import { formatCostValue } from '@/lib/business-order-cost'
import {
  COST_IMPORT_COLUMNS,
  COST_IMPORT_MAX_ROWS,
  type CostImportEntry,
} from '@/lib/business-order-cost-import'

type Choice = 'system' | 'imported'

interface ParsedResult {
  autoFill: CostImportEntry[]
  conflicts: CostImportEntry[]
  unmatched: CostImportEntry[]
  skipped: CostImportEntry[]
}

interface WriteOutcome {
  rowNumber: number
  orderNumber: string
  productName: string
  ok: boolean
  message: string
}

const COLUMN_HINT = [
  COST_IMPORT_COLUMNS.order_number,
  COST_IMPORT_COLUMNS.salesperson_name,
  COST_IMPORT_COLUMNS.product_name,
  COST_IMPORT_COLUMNS.quantity,
  COST_IMPORT_COLUMNS.order_total_amount,
  COST_IMPORT_COLUMNS.cost,
].join(' / ')

function SectionTable({
  title,
  badge,
  children,
}: {
  title: string
  badge?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {badge}
      </div>
      <div className="overflow-x-auto rounded-md border">{children}</div>
    </div>
  )
}

const th = 'p-2 text-left font-medium whitespace-nowrap'
const td = 'p-2 whitespace-nowrap'

export function BusinessOrderCostImporter() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [text, setText] = useState('')
  const [parsed, setParsed] = useState<ParsedResult | null>(null)
  const [choices, setChoices] = useState<Record<number, Choice>>({})
  const [results, setResults] = useState<WriteOutcome[]>([])
  const [pending, startTransition] = useTransition()

  function resetState() {
    setFile(null)
    setText('')
    setParsed(null)
    setChoices({})
    setResults([])
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) resetState()
  }

  async function preview() {
    if (!file && !text.trim()) {
      toast.error('请选择文件或粘贴表格文本')
      return
    }
    const form = new FormData()
    if (file) form.set('file', file)
    if (text.trim()) form.set('text', text)
    startTransition(async () => {
      const response = await fetch('/api/finance/costs/import/preview', { method: 'POST', body: form })
      const result = (await response.json()) as (ParsedResult & { error?: string })
      if (!response.ok || result.error) {
        toast.error(result.error ?? '解析失败')
        return
      }
      setParsed({
        autoFill: result.autoFill ?? [],
        conflicts: result.conflicts ?? [],
        unmatched: result.unmatched ?? [],
        skipped: result.skipped ?? [],
      })
      setChoices({})
      setResults([])
      toast.success('核对完成，请检查冲突并确认写入')
    })
  }

  function choose(rowNumber: number, choice: Choice) {
    setChoices((current) => ({ ...current, [rowNumber]: choice }))
  }

  function chooseAll(choice: Choice) {
    if (!parsed) return
    setChoices(
      Object.fromEntries(parsed.conflicts.map((entry) => [entry.rowNumber, choice])),
    )
  }

  const writes = parsed
    ? [
        ...parsed.autoFill.map((entry) => ({ entry, cost: entry.importedCost })),
        ...parsed.conflicts
          .filter((entry) => choices[entry.rowNumber] === 'imported')
          .map((entry) => ({ entry, cost: entry.importedCost })),
      ].filter((item): item is { entry: CostImportEntry; cost: number } => item.cost !== null && item.entry.itemIds !== null)
    : []

  const unresolvedConflicts = parsed
    ? parsed.conflicts.filter((entry) => !choices[entry.rowNumber]).length
    : 0

  function confirmWrite() {
    if (writes.length === 0) {
      toast.error('没有需要写入的成本（自动填入为空，且冲突未选择“导入值”）')
      return
    }
    startTransition(async () => {
      const outcomes: WriteOutcome[] = []
      for (const { entry, cost } of writes) {
        const result = await updateBusinessOrderItemCostOverride({
          business_order_item_ids: entry.itemIds ?? [],
          cost,
        })
        outcomes.push({
          rowNumber: entry.rowNumber,
          orderNumber: entry.orderNumber,
          productName: entry.productName,
          ok: result.ok,
          message: result.ok
            ? `已写入 ${formatCostValue(cost)}`
            : Object.values(result.fieldErrors ?? {}).flat()[0] ?? result.error ?? '写入失败',
        })
      }
      setResults(outcomes)
      const succeeded = outcomes.filter((outcome) => outcome.ok).length
      router.refresh()
      if (succeeded === outcomes.length) {
        toast.success(`已写入 ${succeeded} 条成本`)
        handleOpenChange(false)
        return
      }
      toast.error(`${succeeded} 条成功，${outcomes.length - succeeded} 条失败，详见结果`)
    })
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Upload className="h-4 w-4" />
        导入成本
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>导入成本表</DialogTitle>
            <DialogDescription>
              上传导出后的成本表（.xlsx / .csv）或粘贴表格文本，系统按 订单号 / 业务员 / 产品名称 / 数量 / 订单总金额
              五项核对，全部无误且系统未填过成本的行自动填入；系统已有成本且与导入不一致的，需人工选择后再写入。
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <p className="text-sm font-medium">上传 .xlsx / .csv（最多 {COST_IMPORT_MAX_ROWS} 行）</p>
                <Input
                  type="file"
                  accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">或粘贴 TSV / CSV</p>
                <Textarea
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="粘贴包含表头的数据"
                  rows={4}
                />
              </div>
            </div>

            <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">需包含表头（顺序可任意，按名称匹配）</p>
              <p className="mt-1 break-all">{COLUMN_HINT}</p>
              <p className="mt-2">
                「产品名称」兼容导出格式「名称 + 换行 + 编码」。导入成本为空的行跳过，不会清空系统现有成本。
                仅与未结算成本行比对（已结算 / 未收齐 / 未全部发货的订单不在其中）。
              </p>
            </div>

            <Button type="button" onClick={preview} disabled={pending}>
              {pending && !parsed ? '核对中…' : '解析并核对'}
            </Button>

            {parsed && (
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">自动填入 {parsed.autoFill.length}</Badge>
                <Badge variant={parsed.conflicts.length > 0 ? 'destructive' : 'secondary'}>
                  冲突待选择 {parsed.conflicts.length}
                </Badge>
                <Badge variant="outline">未匹配 {parsed.unmatched.length}</Badge>
                <Badge variant="outline">跳过 {parsed.skipped.length}</Badge>
              </div>
            )}

            {results.length > 0 && (
              <div className="space-y-1 rounded-md border p-3 text-sm">
                {results.map((outcome) => (
                  <p
                    key={`${outcome.rowNumber}-${outcome.orderNumber}-${outcome.productName}`}
                    className={outcome.ok ? 'text-muted-foreground' : 'text-destructive'}
                  >
                    源行 {outcome.rowNumber} · {outcome.orderNumber} · {outcome.productName}：{outcome.message}
                  </p>
                ))}
              </div>
            )}

            {parsed && parsed.autoFill.length > 0 && (
              <SectionTable title="自动填入" badge={<Badge variant="secondary">{parsed.autoFill.length}</Badge>}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className={th}>源行</th>
                      <th className={th}>订单号</th>
                      <th className={th}>产品名称</th>
                      <th className={th}>数量</th>
                      <th className={th}>系统成本</th>
                      <th className={th}>导入成本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.autoFill.map((entry) => (
                      <tr key={entry.rowNumber} className="border-b align-top">
                        <td className={td}>{entry.rowNumber}</td>
                        <td className={td}>{entry.orderNumber}</td>
                        <td className="p-2">{entry.productName}</td>
                        <td className={td}>{entry.quantityText}</td>
                        <td className={td}>{formatCostValue(entry.systemCost)}</td>
                        <td className={`${td} font-medium`}>{formatCostValue(entry.importedCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </SectionTable>
            )}

            {parsed && parsed.conflicts.length > 0 && (
              <SectionTable
                title="冲突待选择"
                badge={
                  <div className="flex items-center gap-2">
                    <Badge variant="destructive">{parsed.conflicts.length}</Badge>
                    <Button type="button" size="sm" variant="outline" onClick={() => chooseAll('imported')}>
                      全部用导入值
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => chooseAll('system')}>
                      全部用系统值
                    </Button>
                  </div>
                }
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className={th}>源行</th>
                      <th className={th}>订单号</th>
                      <th className={th}>产品名称</th>
                      <th className={th}>数量</th>
                      <th className={th}>系统成本</th>
                      <th className={th}>导入成本</th>
                      <th className={th}>选择</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.conflicts.map((entry) => {
                      const choice = choices[entry.rowNumber]
                      return (
                        <tr key={entry.rowNumber} className="border-b align-top">
                          <td className={td}>{entry.rowNumber}</td>
                          <td className={td}>{entry.orderNumber}</td>
                          <td className="p-2">{entry.productName}</td>
                          <td className={td}>{entry.quantityText}</td>
                          <td className={td}>{formatCostValue(entry.systemCost)}</td>
                          <td className={td}>{formatCostValue(entry.importedCost)}</td>
                          <td className="p-2">
                            <div className="flex gap-3">
                              <label className="flex items-center gap-1">
                                <input
                                  type="radio"
                                  name={`choice-${entry.rowNumber}`}
                                  checked={choice === 'system'}
                                  onChange={() => choose(entry.rowNumber, 'system')}
                                />
                                系统值
                              </label>
                              <label className="flex items-center gap-1">
                                <input
                                  type="radio"
                                  name={`choice-${entry.rowNumber}`}
                                  checked={choice === 'imported'}
                                  onChange={() => choose(entry.rowNumber, 'imported')}
                                />
                                导入值
                              </label>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </SectionTable>
            )}

            {parsed && parsed.unmatched.length > 0 && (
              <SectionTable title="未匹配（不写入）" badge={<Badge variant="outline">{parsed.unmatched.length}</Badge>}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className={th}>源行</th>
                      <th className={th}>订单号</th>
                      <th className={th}>产品名称</th>
                      <th className={th}>原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.unmatched.map((entry) => (
                      <tr key={entry.rowNumber} className="border-b align-top">
                        <td className={td}>{entry.rowNumber}</td>
                        <td className={td}>{entry.orderNumber || '—'}</td>
                        <td className="p-2">{entry.productName || '—'}</td>
                        <td className="p-2 text-destructive">{entry.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </SectionTable>
            )}

            {parsed && parsed.skipped.length > 0 && (
              <SectionTable title="跳过（不写入）" badge={<Badge variant="outline">{parsed.skipped.length}</Badge>}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className={th}>源行</th>
                      <th className={th}>订单号</th>
                      <th className={th}>产品名称</th>
                      <th className={th}>原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.skipped.map((entry) => (
                      <tr key={entry.rowNumber} className="border-b align-top">
                        <td className={td}>{entry.rowNumber}</td>
                        <td className={td}>{entry.orderNumber || '—'}</td>
                        <td className="p-2">{entry.productName || '—'}</td>
                        <td className="p-2 text-muted-foreground">{entry.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </SectionTable>
            )}
          </div>

          <DialogFooter className="items-center gap-2 sm:justify-between">
            <span className="text-sm text-muted-foreground">
              {parsed
                ? `将写入 ${writes.length} 条${unresolvedConflicts > 0 ? `（${unresolvedConflicts} 条冲突未选择，不写入）` : ''}`
                : '请先解析并核对'}
            </span>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                取消
              </Button>
              <Button type="button" disabled={pending || !parsed || writes.length === 0} onClick={confirmWrite}>
                {pending && parsed ? '写入中…' : `确认写入 ${writes.length} 条`}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
