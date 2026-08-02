'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import {
  Search,
  Trash2,
  ImageIcon,
  FileDown,
  Eraser,
  Save,
  Download,
} from 'lucide-react'
import { toast } from 'sonner'
import { updateProductInline } from '@/lib/actions/products'
import { toImageSrc } from '@/lib/supabase/image'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatDate } from '@/lib/utils'
import { getPiItemsForWeight, createWeightCalc } from '@/lib/actions/weight'
import type { Product, ProductGroup, WeightCalcLineItem } from '@/types'

export interface PiOption {
  id: string
  pi_number: string
  customer_name: string
  created_at: string
}

const ALL_GROUPS = '__all__'
const NO_GROUP = '__none__'
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Weight in grams → KG string with up to 3 decimals, trailing zeros trimmed. */
function gToKg(grams: number): string {
  const kg = grams / 1000
  return kg.toLocaleString('en-US', { maximumFractionDigits: 3 })
}

/** Plain number formatter with up to 2 decimals. */
function fmtNum(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

export function WeightCalcClient({
  products,
  groups = [],
  pis = [],
}: {
  products: Product[]
  groups?: ProductGroup[]
  pis?: PiOption[]
}) {
  const [items, setItems] = useState<WeightCalcLineItem[]>([])
  const [query, setQuery] = useState('')
  const [groupFilter, setGroupFilter] = useState(ALL_GROUPS)
  const [bulkQty, setBulkQty] = useState('')
  const [selectedPi, setSelectedPi] = useState('')
  const [importing, startImport] = useTransition()
  const [title, setTitle] = useState('')
  const [sourcePiId, setSourcePiId] = useState<string | null>(null)
  const [saving, startSave] = useTransition()
  const [saved, setSaved] = useState<{ id: string; calc_number: string } | null>(
    null,
  )
  const router = useRouter()
  const [, startWeightSync] = useTransition()
  // Raw string value of a weight field captured on focus, so we only write back
  // to the product library when the value actually changed on blur.
  const focusedWeightRef = useRef<string>('')

  const groupName = useMemo(
    () => new Map(groups.map((g) => [g.id, g.name])),
    [groups],
  )
  const groupOrder = useMemo(
    () => new Map(groups.map((g, index) => [g.id, index])),
    [groups],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = products.filter((p) => {
      const matchQuery =
        !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)
      const matchGroup =
        groupFilter === ALL_GROUPS ||
        (groupFilter === NO_GROUP ? !p.group_id : p.group_id === groupFilter)
      return matchQuery && matchGroup
    })
    const orderOf = (p: Product) =>
      p.group_id && groupOrder.has(p.group_id)
        ? (groupOrder.get(p.group_id) as number)
        : Number.MAX_SAFE_INTEGER
    return matched.sort((a, b) => {
      const diff = orderOf(a) - orderOf(b)
      if (diff !== 0) return diff
      return a.name.localeCompare(b.name)
    })
  }, [products, query, groupFilter, groupOrder])

  const has = (productId: string) => items.some((i) => i.product_id === productId)

  function addProduct(p: Product) {
    if (has(p.id)) return
    setSaved(null)
    setItems((prev) => [
      ...prev,
      {
        product_id: p.id,
        sku: p.sku,
        name: p.name,
        image_url: p.image_url,
        weight_g: p.weight_g ?? null,
        quantity: null,
      },
    ])
  }

  function removeItem(productId: string) {
    setSaved(null)
    setItems((prev) => prev.filter((i) => i.product_id !== productId))
  }

  function setWeight(productId: string, value: string) {
    setSaved(null)
    setItems((prev) =>
      prev.map((i) =>
        i.product_id === productId
          ? { ...i, weight_g: value === '' ? null : Math.max(0, Number(value)) }
          : i,
      ),
    )
  }

  /**
   * On blur, write the edited 克重 back to the product library so the product's
   * weight_g stays in sync. Only fires when the value actually changed since
   * focus, the row maps to a real product (UUID, not a deleted-product synthetic
   * key) and the value is a valid non-negative number. An empty value is treated
   * as "leave the product weight untouched" rather than clearing it.
   */
  function persistWeight(productId: string, before: string, after: string) {
    if (before === after) return
    if (!UUID_RE.test(productId)) return
    if (after.trim() === '') return
    const w = Math.max(0, Number(after))
    if (!Number.isFinite(w)) return
    startWeightSync(async () => {
      try {
        const res = await updateProductInline(productId, { weight_g: w })
        if (res.ok) {
          toast.success('已同步克重到产品库')
          router.refresh()
        } else {
          toast.error(res.error ?? '克重同步到产品库失败')
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '克重同步到产品库失败')
      }
    })
  }

  function setQuantity(productId: string, value: string) {
    setSaved(null)
    setItems((prev) =>
      prev.map((i) =>
        i.product_id === productId
          ? {
              ...i,
              quantity:
                value === '' ? null : Math.max(0, Math.floor(Number(value))),
            }
          : i,
      ),
    )
  }

  function applyBulkQty() {
    const normalized =
      bulkQty === '' || Number.isNaN(Number(bulkQty))
        ? null
        : Math.max(0, Math.floor(Number(bulkQty)))
    setSaved(null)
    setItems((prev) => prev.map((i) => ({ ...i, quantity: normalized })))
  }

  function clearAll() {
    setItems([])
    setSelectedPi('')
    setSourcePiId(null)
    setSaved(null)
    setTitle('')
  }

  function importPi() {
    if (!selectedPi) {
      toast.error('请先选择一张 PI')
      return
    }
    startImport(async () => {
      const rows = await getPiItemsForWeight(selectedPi)
      if (rows.length === 0) {
        toast.error('该 PI 没有可导入的产品')
        return
      }
      setItems(rows)
      setSourcePiId(selectedPi)
      setSaved(null)
      const label = pis.find((p) => p.id === selectedPi)?.pi_number ?? ''
      if (label && !title.trim()) setTitle(label)
      toast.success(`已从 ${label} 导入 ${rows.length} 项产品`)
    })
  }

  function saveCalc() {
    if (items.length === 0) {
      toast.error('请先添加产品')
      return
    }
    startSave(async () => {
      try {
        const res = await createWeightCalc({
          title: title.trim() || undefined,
          source_pi_id: sourcePiId ?? null,
          items: items.map((i) => ({
            product_id: i.product_id,
            sku: i.sku,
            name: i.name,
            image_url: i.image_url,
            weight_g: i.weight_g ?? 0,
            quantity: i.quantity ?? 0,
          })),
        })
        setSaved(res)
        toast.success(`已保存到克重历史：${res.calc_number}`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '保存失败')
      }
    })
  }

  const totalQty = items.reduce((sum, i) => sum + (i.quantity ?? 0), 0)
  const totalWeightG = items.reduce(
    (sum, i) => sum + (i.weight_g ?? 0) * (i.quantity ?? 0),
    0,
  )

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      {/* Left: product picker + PI import */}
      <div className="space-y-3 lg:col-span-2">
        <div className="rounded-md border bg-muted/40 p-3">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            从已有 PI 导入（自动生成计算表）
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select value={selectedPi} onValueChange={setSelectedPi}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="选择一张 PI" />
              </SelectTrigger>
              <SelectContent>
                {pis.length === 0 ? (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">
                    暂无 PI
                  </div>
                ) : (
                  pis.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.pi_number}
                      {p.customer_name ? ` · ${p.customer_name}` : ''} ·{' '}
                      {formatDate(p.created_at)}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              className="shrink-0"
              onClick={importPi}
              disabled={importing}
            >
              <FileDown className="mr-1 h-4 w-4" />
              {importing ? '导入中…' : '导入 PI'}
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            导入会用该 PI 的产品替换当前列表；克重取自 PI 行快照，可再手动修改。
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索产品名称或 SKU"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={groupFilter} onValueChange={setGroupFilter}>
            <SelectTrigger className="sm:w-40">
              <SelectValue placeholder="全部分组" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_GROUPS}>全部分组</SelectItem>
              <SelectItem value={NO_GROUP}>未分组</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
          {filtered.map((p) => {
            const selected = has(p.id)
            return (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-md border p-3"
              >
                <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded border bg-muted">
                  {p.image_url ? (
                    <Image
                      src={toImageSrc(p.image_url)}
                      alt={p.name}
                      fill
                      className="object-cover"
                      sizes="48px"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                      <ImageIcon className="h-5 w-5" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {p.sku} ·{' '}
                    {p.weight_g != null ? `${p.weight_g} g` : '克重未填'}
                  </div>
                  <div className="mt-1">
                    {p.group_id && groupName.has(p.group_id) ? (
                      <Badge variant="outline" className="text-[10px]">
                        {groupName.get(p.group_id)}
                      </Badge>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">
                        未分组
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={selected ? 'secondary' : 'default'}
                  disabled={selected}
                  onClick={() => addProduct(p)}
                >
                  {selected ? '已加入' : '加入'}
                </Button>
              </div>
            )
          })}
          {filtered.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              没有匹配的产品
            </p>
          )}
        </div>
      </div>

      {/* Right: weight calculation table */}
      <div className="space-y-3 lg:col-span-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">重量计算表</h3>
          <div className="flex items-center gap-2">
            {saved && (
              <Button size="sm" variant="outline" asChild>
                <a href={`/api/weight-calc/${saved.id}/xlsx`}>
                  <Download className="mr-1 h-3.5 w-3.5" />
                  下载 Excel
                </a>
              </Button>
            )}
            <Button
              size="sm"
              onClick={saveCalc}
              disabled={items.length === 0 || saving}
            >
              <Save className="mr-1 h-3.5 w-3.5" />
              {saving ? '保存中…' : saved ? '已保存' : '保存到历史'}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={title}
            placeholder="计算单标题（可选，如客户名/批次）"
            onChange={(e) => {
              setTitle(e.target.value)
              setSaved(null)
            }}
            className="h-8 max-w-xs flex-1"
          />
          <Input
            type="number"
            min={0}
            value={bulkQty}
            placeholder="统一数量"
            onChange={(e) => setBulkQty(e.target.value)}
            className="h-8 w-28"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={applyBulkQty}
            disabled={items.length === 0}
          >
            应用数量
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={clearAll}
            disabled={items.length === 0}
            className="text-muted-foreground"
          >
            <Eraser className="mr-1 h-3.5 w-3.5" />
            清空
          </Button>
        </div>

        {items.length === 0 ? (
          <p className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
            从左侧加入产品，或从 PI 导入，自动生成重量计算表
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 text-center">#</TableHead>
                  <TableHead className="min-w-[8rem]">产品</TableHead>
                  <TableHead className="w-28 text-right">克重 (g)</TableHead>
                  <TableHead className="w-24 text-right">数量</TableHead>
                  <TableHead className="w-32 text-right">总重量 (KG)</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item, index) => {
                  const lineG = (item.weight_g ?? 0) * (item.quantity ?? 0)
                  return (
                    <TableRow key={item.product_id}>
                      <TableCell className="text-center text-muted-foreground">
                        {index + 1}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded border bg-muted">
                            {item.image_url ? (
                              <Image
                                src={toImageSrc(item.image_url)}
                                alt={item.name}
                                fill
                                className="object-cover"
                                sizes="40px"
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                                <ImageIcon className="h-4 w-4" />
                              </div>
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate font-medium">
                              {item.name}
                            </div>
                            {item.sku && (
                              <div className="truncate text-xs text-muted-foreground">
                                {item.sku}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          min={0}
                          step="0.001"
                          value={item.weight_g ?? ''}
                          placeholder="克重"
                          onFocus={(e) => {
                            focusedWeightRef.current = e.target.value
                          }}
                          onChange={(e) =>
                            setWeight(item.product_id, e.target.value)
                          }
                          onBlur={(e) =>
                            persistWeight(
                              item.product_id,
                              focusedWeightRef.current,
                              e.target.value,
                            )
                          }
                          className="h-8 text-right"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          min={0}
                          value={item.quantity ?? ''}
                          placeholder="数量"
                          onChange={(e) =>
                            setQuantity(item.product_id, e.target.value)
                          }
                          className="h-8 text-right"
                        />
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {gToKg(lineG)}
                      </TableCell>
                      <TableCell>
                        <button
                          onClick={() => removeItem(item.product_id)}
                          className="text-muted-foreground hover:text-destructive"
                          title="移除"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </TableCell>
                    </TableRow>
                  )
                })}
                <TableRow className="bg-muted/50 font-semibold">
                  <TableCell />
                  <TableCell className="text-right">合计</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums">
                    {fmtNum(totalQty)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {gToKg(totalWeightG)}
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}

        {items.length > 0 && (
          <div className="flex flex-wrap gap-4 rounded-md border bg-muted/40 p-3 text-sm">
            <div>
              <span className="text-muted-foreground">总数量：</span>
              <span className="font-semibold">{fmtNum(totalQty)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">总重量：</span>
              <span className="font-semibold">{gToKg(totalWeightG)} KG</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
