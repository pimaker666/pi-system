'use client'

import { ChangeEvent, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { createBusinessOrder } from '@/lib/actions/business-orders'
import {
  BUSINESS_DAILY_IMPORT_COLUMNS,
  BUSINESS_DAILY_IMPORT_CURRENCY_OPTIONS,
  BUSINESS_DAILY_IMPORT_MAX_ROWS,
  groupBusinessDailyImportRows,
  validateBusinessDailyImportRow,
  type BusinessDailyImportField,
  type BusinessDailyImportRow,
} from '@/lib/business-daily-import'
import {
  PAYMENT_LABELS,
  SHIPPING_LABELS,
  type DailyOrderShopOption,
} from '@/lib/daily-orders'
import { displayProfileName } from '@/lib/utils'
import type { Customer, Product, Profile } from '@/types'

interface Props {
  shops: DailyOrderShopOption[]
  salespeople: Pick<Profile, 'id' | 'full_name' | 'email' | 'chinese_name'>[]
  products: Pick<Product, 'id' | 'name' | 'sku'>[]
  customers: Pick<Customer, 'id' | 'name'>[]
}

type FieldKind =
  | 'date'
  | 'text'
  | 'number'
  | 'money'
  | 'shop'
  | 'sales'
  | 'customer'
  | 'product'
  | 'shipping'
  | 'payment'
  | 'currency'

const fields: ReadonlyArray<readonly [BusinessDailyImportField, string, FieldKind]> = [
  ['order_date', '下单日期', 'date'],
  ['shop_id', '店铺', 'shop'],
  ['salesperson_id', '业务员', 'sales'],
  ['customer_id', '客户', 'customer'],
  ['external_order_number', '订单号', 'text'],
  ['daily_shipping_date', '发货日期', 'date'],
  ['daily_shipping_number', '发货单号', 'text'],
  ['daily_shipping_category', '发货分类', 'shipping'],
  ['product_id', '产品名称', 'product'],
  ['quantity', '数量', 'number'],
  ['unit_price', '销售单价', 'money'],
  ['product_received_amount', '产品实收金额', 'money'],
  ['logistics_fee_amount', '运费实收金额', 'money'],
  ['sales_total_amount', '销售总金额', 'money'],
  ['daily_payment_category', '收款分类', 'payment'],
  ['sales_notes', '备注', 'text'],
  ['currency', '币种', 'currency'],
  ['exchange_rate_to_cny', '汇率', 'money'],
]

interface ImportOutcome {
  orderNumber: string
  rowNumbers: number[]
  ok: boolean
  message: string
}

const selectClass = 'h-9 rounded-md border bg-background px-2'

/**
 * 每日订单批量导入（恢复版）。
 *
 * 与冻结前的旧导入不同：解析后的行会按「订单号 + 店铺 + 业务员 + 客户」合并成一张
 * business_orders 订单的多条明细，再逐张调用 create_business_order_v3 写入，
 * 因此不再触碰已冻结的 finance_daily_* 写链路。
 */
export function BusinessDailyOrderImporter({ shops, salespeople, products, customers }: Props) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [rows, setRows] = useState<BusinessDailyImportRow[]>([])
  const [groupErrors, setGroupErrors] = useState<string[]>([])
  const [results, setResults] = useState<ImportOutcome[]>([])
  const [pending, startTransition] = useTransition()

  const activeShops = shops.filter((shop) => shop.is_active)

  function validateRow(row: BusinessDailyImportRow) {
    return validateBusinessDailyImportRow(row, { shops, salespeople, products, customers })
  }

  async function preview() {
    if (!file && !text.trim()) {
      toast.error('请选择文件或粘贴表格文本')
      return
    }
    const form = new FormData()
    if (file) form.set('file', file)
    if (text.trim()) form.set('text', text)
    const response = await fetch('/api/finance/daily-orders/import/preview', {
      method: 'POST',
      body: form,
    })
    const result = (await response.json()) as { rows?: BusinessDailyImportRow[]; error?: string }
    if (!response.ok || !result.rows) {
      toast.error(result.error ?? '解析失败')
      return
    }
    setRows(result.rows)
    setGroupErrors([])
    setResults([])
    toast.success(`已解析 ${result.rows.length} 行，请校对后保存`)
  }

  function update(index: number, field: BusinessDailyImportField, value: string) {
    setRows((current) =>
      current.map((row, rowIndex) => {
        if (rowIndex !== index) return row
        const next = { ...row, [field]: value } as BusinessDailyImportRow
        if (field === 'shop_id') {
          const assigned = activeShops.find((shop) => shop.id === value)?.salespersonIds ?? []
          if (!assigned.includes(next.salesperson_id)) next.salesperson_id = ''
        }
        if (field === 'currency' && value === 'CNY') next.exchange_rate_to_cny = '1'
        next.errors = validateRow(next)
        return next
      }),
    )
  }

  function inputFor(
    row: BusinessDailyImportRow,
    index: number,
    field: BusinessDailyImportField,
    kind: FieldKind,
  ) {
    const value = String(row[field] ?? '')
    const onSelect = (event: ChangeEvent<HTMLSelectElement>) => update(index, field, event.target.value)

    if (kind === 'shop') {
      return (
        <select className={`${selectClass} min-w-32`} value={value} onChange={onSelect}>
          <option value="">请选择</option>
          {activeShops.map((shop) => (
            <option key={shop.id} value={shop.id}>{shop.name}</option>
          ))}
        </select>
      )
    }
    if (kind === 'sales') {
      const allowed = new Set(activeShops.find((shop) => shop.id === row.shop_id)?.salespersonIds ?? [])
      return (
        <select className={`${selectClass} min-w-32`} value={value} onChange={onSelect}>
          <option value="">请选择</option>
          {salespeople
            .filter((person) => allowed.has(person.id))
            .map((person) => (
              <option key={person.id} value={person.id}>{displayProfileName(person)}</option>
            ))}
        </select>
      )
    }
    if (kind === 'customer') {
      return (
        <select className={`${selectClass} min-w-40`} value={value} onChange={onSelect}>
          <option value="">请选择</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>{customer.name}</option>
          ))}
        </select>
      )
    }
    if (kind === 'product') {
      return (
        <select className={`${selectClass} min-w-48`} value={value} onChange={onSelect}>
          <option value="">请选择</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>{product.sku} · {product.name}</option>
          ))}
        </select>
      )
    }
    if (kind === 'shipping') {
      return (
        <select className={selectClass} value={value} onChange={onSelect}>
          {Object.entries(SHIPPING_LABELS).map(([code, label]) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </select>
      )
    }
    if (kind === 'payment') {
      return (
        <select className={selectClass} value={value} onChange={onSelect}>
          {Object.entries(PAYMENT_LABELS).map(([code, label]) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </select>
      )
    }
    if (kind === 'currency') {
      return (
        <select className={selectClass} value={value} onChange={onSelect}>
          <option value="">请选择</option>
          {BUSINESS_DAILY_IMPORT_CURRENCY_OPTIONS.map((code) => (
            <option key={code} value={code}>{code}</option>
          ))}
        </select>
      )
    }
    return (
      <Input
        className={kind === 'text' ? 'min-w-32' : 'min-w-24'}
        type={kind === 'date' ? 'date' : kind === 'text' ? 'text' : 'number'}
        min={kind === 'number' ? '0.0001' : kind === 'money' ? '0' : undefined}
        step={kind === 'number' ? '0.0001' : kind === 'money' ? '0.01' : undefined}
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) => update(index, field, event.target.value)}
      />
    )
  }

  function save() {
    const validated = rows.map((row) => ({ ...row, errors: validateRow(row) }))
    setRows(validated)
    const invalidCount = validated.filter((row) => row.errors.length > 0).length
    if (invalidCount > 0) {
      toast.error(`仍有 ${invalidCount} 行需要校对，修正后再保存`)
      return
    }

    const { groups, errors } = groupBusinessDailyImportRows(validated)
    setGroupErrors(errors)
    if (errors.length > 0) {
      toast.error(`有 ${errors.length} 张订单的表头字段冲突，请先修正`)
      return
    }
    if (groups.length === 0) {
      toast.error('没有可导入的订单')
      return
    }

    startTransition(async () => {
      const outcomes: ImportOutcome[] = []
      const failedRowNumbers = new Set<number>()
      for (const group of groups) {
        const result = await createBusinessOrder(group.input)
        if (result.ok) {
          outcomes.push({
            orderNumber: group.orderNumber,
            rowNumbers: group.rowNumbers,
            ok: true,
            message: `已创建 ${result.order_number ?? ''}`.trim(),
          })
          continue
        }
        outcomes.push({
          orderNumber: group.orderNumber,
          rowNumbers: group.rowNumbers,
          ok: false,
          message: result.error ?? '创建订单失败',
        })
        group.rowNumbers.forEach((rowNumber) => failedRowNumbers.add(rowNumber))
      }

      setResults(outcomes)
      // 只保留失败订单的源行，成功的行从预览表移除，便于逐张重试。
      setRows((current) => current.filter((row) => failedRowNumbers.has(row.rowNumber)))
      const succeeded = outcomes.filter((outcome) => outcome.ok).length
      router.refresh()
      if (failedRowNumbers.size === 0) {
        toast.success(`已导入 ${succeeded} 张订单`)
        router.push('/finance/daily-orders')
        return
      }
      toast.error(`${succeeded} 张成功，${outcomes.length - succeeded} 张失败，失败行已保留`)
    })
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <p className="text-sm font-medium">上传 .xlsx / .csv（最多 {BUSINESS_DAILY_IMPORT_MAX_ROWS} 行）</p>
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
            rows={5}
          />
        </div>
      </div>

      <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">表头顺序（可任意排列，按名称匹配）</p>
        <p className="mt-1 break-all">{BUSINESS_DAILY_IMPORT_COLUMNS.join(' / ')}</p>
        <p className="mt-2">
          同一「订单号 + 店铺 + 业务员 + 客户」的多行会合并成一张订单的多条明细，
          下单日期、发货日期、发货单号、收款分类、备注、币种与汇率必须在这些行里保持一致。
        </p>
      </div>

      <Button type="button" onClick={preview} disabled={pending}>解析并预览</Button>

      {groupErrors.length > 0 && (
        <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {groupErrors.map((error) => <p key={error}>{error}</p>)}
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-1 rounded-md border p-3 text-sm">
          {results.map((outcome) => (
            <p
              key={`${outcome.orderNumber}-${outcome.rowNumbers.join('-')}`}
              className={outcome.ok ? 'text-muted-foreground' : 'text-destructive'}
            >
              订单号 {outcome.orderNumber}（源行 {outcome.rowNumbers.join('、')}）：{outcome.message}
            </p>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-md border">
            <table className="min-w-[2400px] text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="p-2 text-left">源行</th>
                  {fields.map(([field, label]) => <th key={field} className="p-2 text-left">{label}</th>)}
                  <th className="p-2 text-left">问题</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.rowNumber} className="border-b align-top">
                    <td className="p-2">{row.rowNumber}</td>
                    {fields.map(([field, , kind]) => (
                      <td key={field} className="p-2">{inputFor(row, index, field, kind)}</td>
                    ))}
                    <td className="p-2 text-destructive">{row.errors.join('；')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end">
            <Button onClick={save} disabled={pending}>
              {pending ? '保存中…' : `保存 ${rows.length} 行`}
            </Button>
          </div>
        </>
      )}

      <p className="text-sm text-muted-foreground">
        金额可写成“CNY 1,234.56”或“USD 1,234.56”；产品实收留空按单价乘数量计算，销售总金额留空按产品实收加运费实收计算。
        Excel 内嵌截图不会自动导入，请保存后进入订单编辑页补传。
      </p>
    </div>
  )
}
