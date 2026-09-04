'use client'

import { ChangeEvent, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { bulkCreateDailyOrders } from '@/lib/actions/daily-orders'
import { validateDailyOrderImportRow, type DailyOrderImportRow } from '@/lib/daily-orders'
import type { DailyOrderShopOption } from './daily-order-form'
import type { Product, Profile } from '@/types'

interface Props {
  shops: DailyOrderShopOption[]
  salespeople: Pick<Profile, 'id' | 'full_name' | 'email'>[]
  products: Pick<Product, 'id' | 'name' | 'sku'>[]
}

const fields = [
  ['order_date', '下单日期', 'date'], ['shop_id', '店铺', 'shop'], ['salesperson_id', '业务员', 'sales'],
  ['order_number', '订单号', 'text'], ['shipping_date', '发货日期', 'date'], ['shipping_number', '发货单号', 'text'],
  ['shipping_category', '发货分类', 'shipping'], ['product_id', '产品名称', 'product'], ['quantity', '数量', 'number'],
  ['sales_unit_price_amount', '销售单价', 'money'], ['product_received_amount', '产品实收金额', 'money'],
  ['logistics_fee_amount', '物流费用', 'money'], ['sales_total_amount', '销售总金额', 'money'],
  ['payment_category', '收款分类', 'payment'], ['remarks', '备注', 'text'],
] as const

type Field = (typeof fields)[number][0]

const moneyCurrencyFields = {
  sales_unit_price_amount: 'sales_unit_price_currency',
  product_received_amount: 'product_received_currency',
  logistics_fee_amount: 'logistics_fee_currency',
  sales_total_amount: 'sales_total_currency',
} as const

export function DailyOrderImporter({ shops, salespeople, products }: Props) {
  const router = useRouter()
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [rows, setRows] = useState<DailyOrderImportRow[]>([])
  const [pending, startTransition] = useTransition()

  async function preview() {
    if (!file && !text.trim()) return toast.error('请选择文件或粘贴表格文本')
    const form = new FormData()
    if (file) form.set('file', file)
    if (text.trim()) form.set('text', text)
    const response = await fetch('/api/finance/daily-orders/import/preview', { method: 'POST', body: form })
    const result = await response.json() as { rows?: DailyOrderImportRow[]; error?: string }
    if (!response.ok || !result.rows) return toast.error(result.error ?? '解析失败')
    setRows(result.rows)
    toast.success(`已解析 ${result.rows.length} 行，请校对后保存`)
  }

  function validateRow(row: DailyOrderImportRow) {
    return validateDailyOrderImportRow(row, { shops, salespeople, products })
  }

  function update(index: number, field: string, value: string) {
    setRows((current) => current.map((row, rowIndex) => {
      if (rowIndex !== index) return row
      const next = { ...row, [field]: value }
      if (field === 'shop_id') {
        const assignedIds = shops.find((shop) => shop.id === value)?.salespersonIds ?? []
        if (!assignedIds.includes(String(next.salesperson_id ?? ''))) next.salesperson_id = ''
      }
      next.errors = validateRow(next)
      return next
    }))
  }

  function inputFor(row: DailyOrderImportRow, index: number, field: Field, kind: string) {
    const value = String(row[field] ?? '')
    if (kind === 'shop') return <select className="h-9 min-w-32 rounded-md border bg-background px-2" value={value} onChange={(e) => update(index, field, e.target.value)}><option value="">请选择</option>{shops.filter((shop) => shop.is_active).map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}</select>
    if (kind === 'sales') {
      const shop = shops.find((item) => item.id === row.shop_id)
      const allowed = new Set(shop?.salespersonIds ?? [])
      return <select className="h-9 min-w-32 rounded-md border bg-background px-2" value={value} onChange={(e) => update(index, field, e.target.value)}><option value="">请选择</option>{salespeople.filter((person) => allowed.has(person.id)).map((person) => <option key={person.id} value={person.id}>{person.full_name || person.email}</option>)}</select>
    }
    if (kind === 'product') return <select className="h-9 min-w-48 rounded-md border bg-background px-2" value={value} onChange={(e) => update(index, field, e.target.value)}><option value="">请选择</option>{products.map((product) => <option key={product.id} value={product.id}>{product.sku} · {product.name}</option>)}</select>
    if (kind === 'shipping') return <select className="h-9 rounded-md border bg-background px-2" value={value} onChange={(e) => update(index, field, e.target.value)}><option value="stock">现货</option><option value="sample">样品</option><option value="custom">定制</option><option value="purchase">外采</option></select>
    if (kind === 'payment') return <select className="h-9 rounded-md border bg-background px-2" value={value} onChange={(e) => update(index, field, e.target.value)}><option value="full">全款</option><option value="deposit">定金</option><option value="balance">尾款</option></select>
    if (kind === 'money') {
      const currencyField = moneyCurrencyFields[field as keyof typeof moneyCurrencyFields]
      return <div className="flex min-w-44 gap-1"><select className="h-9 rounded-md border bg-background px-1" value={String(row[currencyField] ?? 'CNY')} onChange={(e) => update(index, currencyField, e.target.value)}><option>CNY</option><option>USD</option></select><Input className="min-w-24" type="number" min="0" step="0.01" value={value} onChange={(e) => update(index, field, e.target.value)} /></div>
    }
    return <Input className="min-w-32" type={kind} min={kind === 'number' ? '0.0001' : undefined} step={kind === 'number' ? '0.0001' : undefined} value={value} onChange={(e: ChangeEvent<HTMLInputElement>) => update(index, field, e.target.value)} />
  }

  function save() {
    const validatedRows: DailyOrderImportRow[] = rows.map((row) => ({ ...row, errors: validateRow(row) }))
    setRows(validatedRows)
    const invalidCount = validatedRows.filter((row) => row.errors.length > 0).length
    if (invalidCount > 0) {
      toast.error(`仍有 ${invalidCount} 行需要校对，修正后再保存`)
      return
    }
    startTransition(async () => {
      const payload = validatedRows.map(({ rowNumber: _rowNumber, errors: _errors, shop_name: _shopName, salesperson_name: _salesName, product_name: _productName, ...row }) => row)
      const result = await bulkCreateDailyOrders(payload)
      if (!result.ok) {
        toast.error(result.error ?? '批量保存失败')
        return
      }
      toast.success(`已导入 ${validatedRows.length} 行`)
      router.push('/finance/daily-orders')
      router.refresh()
    })
  }

  return <div className="space-y-6">
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-2"><p className="text-sm font-medium">上传 .xlsx / .csv（最多500行）</p><Input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></div>
      <div className="space-y-2"><p className="text-sm font-medium">或粘贴 TSV / CSV</p><Textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="粘贴包含表头的数据" rows={5} /></div>
    </div>
    <Button type="button" onClick={preview} disabled={pending}>解析并预览</Button>
    {rows.length > 0 && <>
      <div className="overflow-x-auto rounded-md border"><table className="min-w-[2200px] text-sm"><thead><tr className="border-b bg-muted/50"><th className="p-2 text-left">源行</th>{fields.map(([, label]) => <th key={label} className="p-2 text-left">{label}</th>)}<th className="p-2 text-left">问题</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.rowNumber} className="border-b align-top"><td className="p-2">{row.rowNumber}</td>{fields.map(([field, , kind]) => <td key={field} className="p-2">{inputFor(row, index, field, kind)}</td>)}<td className="p-2 text-destructive">{row.errors.join('；')}</td></tr>)}</tbody></table></div>
      <div className="flex justify-end"><Button onClick={save} disabled={pending}>{pending ? '保存中…' : `保存 ${rows.length} 行`}</Button></div>
    </>}
    <p className="text-sm text-muted-foreground">金额可写成“CNY 1,234.56”或“USD 1,234.56”。Excel 内嵌截图不会自动导入，请保存后进入编辑页补传。</p>
  </div>
}
