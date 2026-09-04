'use client'

import { useState, useMemo, useEffect, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Pencil, Trash2, FolderInput, DollarSign, Save, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ImagePreview } from '@/components/ui/image-preview'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { formatCurrency } from '@/lib/utils'
import {
  bulkUpdateGroup,
  bulkUpdatePrice,
  bulkUpdateProducts,
  bulkDeleteProducts,
  updateProductFinancials,
  updateProductInline,
} from '@/lib/actions/products'
import type { Product, ProductFinancial, ProductGroup } from '@/types'

const NO_GROUP = '__none__'
const KEEP = '__keep__'
const CURRENCIES = ['USD', 'EUR', 'CNY', 'GBP', 'JPY'] as const

/**
 * Inline-editable table cell shown as an open input field. Saves on blur or
 * Enter, but only when the trimmed draft actually differs from the initial
 * value. On error it reverts the draft and shows a toast. When `disabled`
 * (viewer without manage rights) it renders the value as read-only text.
 */
function InlineEditableCell({
  productId,
  field,
  initial,
  placeholder,
  numeric = false,
  disabled = false,
}: {
  productId: string
  field: 'specification' | 'weight_g'
  initial: string
  placeholder?: string
  numeric?: boolean
  disabled?: boolean
}) {
  const router = useRouter()
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState(false)

  // Keep the draft in sync when the parent re-renders with a refreshed value
  // (e.g. after router.refresh() or a bulk edit) — but not while the user is
  // mid-edit is handled by comparing against initial on each render.
  useEffect(() => {
    setDraft(initial)
  }, [initial])

  if (disabled) {
    return initial ? (
      <span className="line-clamp-2 text-sm text-muted-foreground">{initial}</span>
    ) : (
      <span className="text-muted-foreground">—</span>
    )
  }

  async function commit() {
    const trimmed = draft.trim()
    if (trimmed === initial.trim()) return

    if (numeric && trimmed !== '') {
      const n = Number(trimmed)
      if (!Number.isFinite(n) || n < 0) {
        toast.error('克重必须是非负数字')
        setDraft(initial)
        return
      }
    }

    const patch =
      field === 'weight_g'
        ? { weight_g: trimmed === '' ? null : Number(trimmed) }
        : { specification: trimmed }

    setSaving(true)
    const result = await updateProductInline(productId, patch)
    setSaving(false)
    if (result.ok) {
      toast.success('已保存')
      router.refresh()
    } else {
      toast.error(result.error ?? '保存失败')
      setDraft(initial)
    }
  }

  return (
    <Input
      value={draft}
      type={numeric ? 'number' : 'text'}
      step={numeric ? '0.001' : undefined}
      min={numeric ? 0 : undefined}
      disabled={saving}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      className="h-8 w-full"
    />
  )
}

function ProductFinancialCells({
  productId,
  financial,
}: {
  productId: string
  financial?: ProductFinancial
}) {
  const router = useRouter()
  const [financialNumber, setFinancialNumber] = useState(financial?.financial_number ?? '')
  const [productName, setProductName] = useState(financial?.product_name ?? '')
  const [cost, setCost] = useState(financial?.cost != null ? String(financial.cost) : '')
  const [saving, setSaving] = useState(false)

  const initialNumber = financial?.financial_number ?? ''
  const initialName = financial?.product_name ?? ''
  const initialCost = financial?.cost != null ? String(financial.cost) : ''
  const normalizedNumber = financialNumber.trim()
  const normalizedName = productName.trim()
  const normalizedCost = cost.trim()
  const unchanged =
    normalizedNumber === initialNumber &&
    normalizedName === initialName &&
    normalizedCost === initialCost

  async function save() {
    const numericCost = normalizedCost === '' ? null : Number(normalizedCost)
    if (numericCost !== null && (!Number.isFinite(numericCost) || numericCost < 0)) {
      toast.error('成本必须是非负数字')
      return
    }

    setSaving(true)
    const result = await updateProductFinancials({
      product_id: productId,
      financial_number: normalizedNumber,
      product_name: normalizedName,
      cost: numericCost,
    })
    setSaving(false)

    if (result.ok) {
      toast.success('财务资料已保存')
      router.refresh()
      return
    }

    const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
    toast.error(firstFieldError ?? result.error ?? '保存失败')
  }

  function saveOnEnter(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && !saving && !unchanged) {
      event.preventDefault()
      void save()
    }
  }

  return (
    <>
      <TableCell className="min-w-40 align-top">
        <Input
          value={financialNumber}
          maxLength={100}
          disabled={saving}
          placeholder="财务编号"
          onChange={(event) => setFinancialNumber(event.target.value)}
          onKeyDown={saveOnEnter}
          className="h-8"
        />
      </TableCell>
      <TableCell className="min-w-48 align-top">
        <Input
          value={productName}
          maxLength={200}
          disabled={saving}
          placeholder="产品名称"
          onChange={(event) => setProductName(event.target.value)}
          onKeyDown={saveOnEnter}
          className="h-8"
        />
      </TableCell>
      <TableCell className="min-w-40 align-top">
        <div className="flex items-center gap-2">
          <Input
            value={cost}
            type="number"
            step="0.0001"
            min={0}
            disabled={saving}
            placeholder="成本"
            onChange={(event) => setCost(event.target.value)}
            onKeyDown={saveOnEnter}
            className="h-8"
          />
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-8 w-8 shrink-0"
            disabled={saving || unchanged}
            aria-label="保存产品财务资料"
            title="保存产品财务资料"
            onClick={save}
          >
            <Save className="h-4 w-4" />
          </Button>
        </div>
      </TableCell>
    </>
  )
}

export function ProductTable({
  products,
  groups,
  financials,
  canManage,
  canDelete,
  canManageFinancials,
}: {
  products: Product[]
  groups: ProductGroup[]
  financials: ProductFinancial[]
  canManage: boolean
  canDelete: boolean
  canManageFinancials: boolean
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, startTransition] = useTransition()

  const [groupOpen, setGroupOpen] = useState(false)
  const [priceOpen, setPriceOpen] = useState(false)
  const [delOpen, setDelOpen] = useState(false)
  const [groupValue, setGroupValue] = useState(NO_GROUP)
  const [priceValue, setPriceValue] = useState('')

  const [editOpen, setEditOpen] = useState(false)
  const [eCurrency, setECurrency] = useState<string>(KEEP)
  const [eUnit, setEUnit] = useState('')
  const [eCategory, setECategory] = useState('')
  const [eSpecification, setESpecification] = useState('')

  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups])
  const financialByProduct = useMemo(
    () => new Map(financials.map((financial) => [financial.product_id, financial])),
    [financials],
  )

  const allChecked = products.length > 0 && selected.size === products.length
  const someChecked = selected.size > 0 && !allChecked

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(products.map((p) => p.id)))
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const ids = useMemo(() => Array.from(selected), [selected])

  function handleGroup() {
    startTransition(async () => {
      const result = await bulkUpdateGroup(ids, groupValue === NO_GROUP ? null : groupValue)
      if (result.ok) {
        toast.success(`已调整 ${ids.length} 个产品的分组`)
        setGroupOpen(false)
        setSelected(new Set())
        router.refresh()
      } else {
        toast.error(result.error ?? '操作失败')
      }
    })
  }

  function handlePrice() {
    const price = Number(priceValue)
    if (!Number.isFinite(price) || price < 0) {
      toast.error('请输入有效的非负价格')
      return
    }
    startTransition(async () => {
      const result = await bulkUpdatePrice(ids, price)
      if (result.ok) {
        toast.success(`已更新 ${ids.length} 个产品的单价`)
        setPriceOpen(false)
        setSelected(new Set())
        router.refresh()
      } else {
        toast.error(result.error ?? '操作失败')
      }
    })
  }

  function openEdit() {
    setECurrency(KEEP)
    setEUnit('')
    setECategory('')
    setESpecification('')
    setEditOpen(true)
  }

  function handleModify() {
    const patch = {
      currency: eCurrency === KEEP ? '' : eCurrency,
      unit: eUnit.trim(),
      category: eCategory.trim(),
      specification: eSpecification.trim(),
    }
    if (!patch.currency && !patch.unit && !patch.category && !patch.specification) {
      toast.error('请至少填写一个要修改的字段')
      return
    }
    startTransition(async () => {
      const result = await bulkUpdateProducts(ids, patch)
      if (result.ok) {
        toast.success(`已修改 ${ids.length} 个产品`)
        setEditOpen(false)
        setSelected(new Set())
        router.refresh()
      } else {
        toast.error(result.error ?? '修改失败')
      }
    })
  }

  function handleDelete() {
    startTransition(async () => {
      const result = await bulkDeleteProducts(ids)
      if (result.ok) {
        toast.success(`已删除 ${ids.length} 个产品`)
        setDelOpen(false)
        setSelected(new Set())
        router.refresh()
      } else {
        toast.error(result.error ?? '删除失败')
      }
    })
  }

  return (
    <div className="space-y-3">
      {canManage && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-4 py-2">
          <span className="text-sm font-medium">已选 {selected.size} 项</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setGroupValue(NO_GROUP)
                setGroupOpen(true)
              }}
            >
              <FolderInput className="h-3.5 w-3.5" />
              调整分组
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={openEdit}
            >
              <Settings2 className="h-3.5 w-3.5" />
              修改
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPriceValue('')
                setPriceOpen(true)
              }}
            >
              <DollarSign className="h-3.5 w-3.5" />
              调整单价
            </Button>
            {canDelete && (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                onClick={() => setDelOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              取消选择
            </Button>
          </div>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                {canManage && (
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={allChecked}
                      ref={(el) => {
                        if (el) el.indeterminate = someChecked
                      }}
                      onChange={toggleAll}
                      aria-label="全选"
                    />
                  </TableHead>
                )}
                <TableHead className="w-16">图片</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>{canManageFinancials ? '销售名称' : '名称'}</TableHead>
                {canManageFinancials && (
                  <>
                    <TableHead>财务编号</TableHead>
                    <TableHead>产品名称</TableHead>
                    <TableHead>成本</TableHead>
                  </>
                )}
                <TableHead className="w-44">规格</TableHead>
                <TableHead className="w-28">克重(g)</TableHead>
                <TableHead>分组</TableHead>
                <TableHead className="text-right">单价</TableHead>
                <TableHead>状态</TableHead>
                {canManage && <TableHead className="text-right">操作</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.id} data-state={selected.has(p.id) ? 'selected' : undefined}>
                  {canManage && (
                    <TableCell>
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={selected.has(p.id)}
                        onChange={() => toggleOne(p.id)}
                        aria-label={`选择 ${p.name}`}
                      />
                    </TableCell>
                  )}
                  <TableCell>
                    <ImagePreview
                      src={p.image_url}
                      alt={p.name}
                      size="h-10 w-10"
                      sizes="40px"
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.sku}</TableCell>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  {canManageFinancials && (
                    <ProductFinancialCells
                      key={`${p.id}:${financialByProduct.get(p.id)?.updated_at ?? 'new'}`}
                      productId={p.id}
                      financial={financialByProduct.get(p.id)}
                    />
                  )}
                  <TableCell className="max-w-[180px] align-top">
                    <InlineEditableCell
                      productId={p.id}
                      field="specification"
                      initial={p.specification ?? ''}
                      placeholder="规格"
                      disabled={!canManage}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <InlineEditableCell
                      productId={p.id}
                      field="weight_g"
                      initial={p.weight_g != null ? String(p.weight_g) : ''}
                      placeholder="克重"
                      numeric
                      disabled={!canManage}
                    />
                  </TableCell>
                  <TableCell>
                    {p.group_id && groupName.has(p.group_id) ? (
                      <Badge variant="outline">{groupName.get(p.group_id)}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(p.unit_price, p.currency)} / {p.unit}
                  </TableCell>
                  <TableCell>
                    {p.is_active ? (
                      <Badge variant="success">上架</Badge>
                    ) : (
                      <Badge variant="muted">下架</Badge>
                    )}
                  </TableCell>
                  {canManage && (
                    <TableCell className="text-right">
                      <Button asChild variant="ghost" size="icon" className="h-8 w-8">
                        <Link href={`/products/${p.id}/edit`}>
                          <Pencil className="h-4 w-4" />
                        </Link>
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {products.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={(canManage ? 10 : 8) + (canManageFinancials ? 3 : 0)}
                    className="py-10 text-center text-muted-foreground"
                  >
                    没有符合条件的产品
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 批量修改 */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>批量修改（{selected.size} 项）</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>币种</Label>
              <Select value={eCurrency} onValueChange={setECurrency}>
                <SelectTrigger>
                  <SelectValue placeholder="不修改" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={KEEP}>不修改</SelectItem>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>单位</Label>
              <Input
                value={eUnit}
                onChange={(e) => setEUnit(e.target.value)}
                placeholder="留空则不修改，例如 pcs / box"
              />
            </div>
            <div className="space-y-1.5">
              <Label>类别</Label>
              <Input
                value={eCategory}
                onChange={(e) => setECategory(e.target.value)}
                placeholder="留空则不修改"
              />
            </div>
            <div className="space-y-1.5">
              <Label>SPECIFICATION（规格）</Label>
              <Input
                value={eSpecification}
                onChange={(e) => setESpecification(e.target.value)}
                placeholder="留空则不修改，例如 50ml / 24pcs per box"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              只会更新你填写了值的字段，留空的字段保持每个产品原值不变。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button onClick={handleModify} disabled={pending}>
              {pending ? '处理中…' : '确定'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量调整分组 */}
      <Dialog open={groupOpen} onOpenChange={setGroupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>批量调整分组（{selected.size} 项）</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>目标分组</Label>
            <Select value={groupValue} onValueChange={setGroupValue}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_GROUP}>未分组</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGroupOpen(false)}>
              取消
            </Button>
            <Button onClick={handleGroup} disabled={pending}>
              {pending ? '保存中…' : '确定'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量调整单价 */}
      <Dialog open={priceOpen} onOpenChange={setPriceOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>批量调整单价（{selected.size} 项）</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="bulk-price">统一单价</Label>
            <Input
              id="bulk-price"
              type="number"
              step="0.01"
              min="0"
              value={priceValue}
              onChange={(e) => setPriceValue(e.target.value)}
              placeholder="例如 2.50"
            />
            <p className="text-xs text-muted-foreground">
              所选产品的单价将统一设为此值（不改变币种）。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPriceOpen(false)}>
              取消
            </Button>
            <Button onClick={handlePrice} disabled={pending}>
              {pending ? '保存中…' : '确定'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量删除 */}
      <AlertDialog open={delOpen} onOpenChange={setDelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除所选 {selected.size} 个产品？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后不可恢复。已开具的历史 PI 不受影响（其中已保存产品快照）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleDelete()
              }}
              disabled={pending}
            >
              {pending ? '删除中…' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
