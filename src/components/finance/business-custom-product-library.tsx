'use client'

import { useMemo, useState, useTransition } from 'react'
import { Archive, Loader2, RefreshCw, RotateCcw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ImagePreview } from '@/components/ui/image-preview'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  listBusinessCustomProductsLibrary,
  setBusinessCustomProductState,
} from '@/lib/actions/business-orders'
import { formatCurrency } from '@/lib/utils'
import type {
  BusinessCustomProductLibraryItem,
  BusinessCustomProductListItem,
  BusinessCustomProductOrderAmount,
  BusinessCustomProductOrderHistoryItem,
  CurrencyCode,
  ProductGroup,
  Profile,
} from '@/types'
import { BusinessCustomProductDialog } from './business-custom-product-dialog'

const ALL = '__all__'

type NormalizedProduct = BusinessCustomProductListItem & Pick<
  BusinessCustomProductLibraryItem,
  'order_history' | 'total_order_quantity' | 'total_order_amounts'
> & {
  version_count: number
}

interface BusinessCustomProductLibraryProps {
  initialProducts: BusinessCustomProductLibraryItem[]
  productGroups: ProductGroup[]
  profileRole: Profile['role']
  initialError?: string | null
}

function normalizeProduct(raw: BusinessCustomProductLibraryItem): NormalizedProduct {
  const row = raw as unknown as Record<string, unknown>
  return {
    custom_product_id: String(row.custom_product_id ?? ''),
    is_archived: Boolean(row.is_archived),
    created_by: typeof row.created_by === 'string' ? row.created_by : null,
    created_at: String(row.created_at ?? ''),
    updated_by: typeof row.updated_by === 'string' ? row.updated_by : null,
    updated_at: String(row.updated_at ?? ''),
    version_id: String(row.latest_version_id ?? ''),
    version_no: Number(row.latest_version_no ?? 0),
    product_group_id: typeof row.product_group_id === 'string' ? row.product_group_id : null,
    product_group_name: typeof row.product_group_name === 'string' ? row.product_group_name : null,
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    description: typeof row.description === 'string' ? row.description : null,
    specification: typeof row.specification === 'string' ? row.specification : null,
    unit: String(row.unit ?? ''),
    image_url: typeof row.image_url === 'string' ? row.image_url : null,
    quantity: row.quantity == null ? null : Number(row.quantity),
    default_unit_price: Number(row.default_unit_price ?? 0),
    default_currency: (row.default_currency as CurrencyCode | null) ?? 'USD',
    order_amount: row.order_amount == null ? null : Number(row.order_amount),
    received_amount: row.received_amount == null ? null : Number(row.received_amount),
    outstanding_amount: row.outstanding_amount == null ? null : Number(row.outstanding_amount),
    order_history: Array.isArray(row.order_history)
      ? row.order_history as BusinessCustomProductOrderHistoryItem[]
      : [],
    total_order_quantity: Number(row.total_order_quantity ?? 0),
    total_order_amounts: Array.isArray(row.total_order_amounts)
      ? row.total_order_amounts as BusinessCustomProductOrderAmount[]
      : [],
    version_count: Number(row.version_count ?? 0),
  }
}

function groupOrderHistory(history: BusinessCustomProductOrderHistoryItem[]) {
  const groups = new Map<string, {
    code: string
    image_url: string | null
    unit: string
    quantity: number
    amounts: Map<CurrencyCode, number>
    orders: BusinessCustomProductOrderHistoryItem[]
  }>()
  for (const order of history) {
    const key = `${order.code}\u0000${order.image_url ?? ''}`
    const group = groups.get(key) ?? {
      code: order.code,
      image_url: order.image_url,
      unit: order.unit,
      quantity: 0,
      amounts: new Map<CurrencyCode, number>(),
      orders: [],
    }
    group.quantity += Number(order.quantity)
    group.amounts.set(order.currency, (group.amounts.get(order.currency) ?? 0) + Number(order.order_amount))
    group.orders.push(order)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function latestProducts(rows: BusinessCustomProductLibraryItem[]) {
  return rows
    .map(normalizeProduct)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

export function BusinessCustomProductLibrary({
  initialProducts,
  productGroups,
  profileRole,
  initialError = null,
}: BusinessCustomProductLibraryProps) {
  const canManageState = profileRole === 'admin' || profileRole === 'finance'
  const [products, setProducts] = useState(initialProducts)
  const [error, setError] = useState(initialError)
  const [query, setQuery] = useState('')
  const [groupFilter, setGroupFilter] = useState(ALL)
  const [statusFilter, setStatusFilter] = useState('active')
  const [refreshing, startRefresh] = useTransition()
  const [stateProductId, setStateProductId] = useState<string | null>(null)

  const normalizedProducts = useMemo(() => latestProducts(products), [products])
  const filteredProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return normalizedProducts.filter((product) => {
      const matchesQuery = !normalizedQuery || [
        product.code,
        product.name,
        product.specification,
        product.description,
        product.product_group_name,
      ].filter(Boolean).some((value) => String(value).toLocaleLowerCase().includes(normalizedQuery))
      const matchesGroup = groupFilter === ALL || product.product_group_id === groupFilter
      const matchesStatus = statusFilter === ALL || (statusFilter === 'active' ? !product.is_archived : product.is_archived)
      return matchesQuery && matchesGroup && matchesStatus
    })
  }, [groupFilter, normalizedProducts, query, statusFilter])

  async function loadProducts() {
    const result = await listBusinessCustomProductsLibrary({ status: 'all' })
    if (!result.ok) {
      setError(result.error ?? '读取定制产品库失败')
      return false
    }
    setProducts(result.data ?? [])
    setError(null)
    return true
  }

  function refresh() {
    startRefresh(async () => {
      if (await loadProducts()) toast.success('定制产品库已刷新')
    })
  }

  function handleSaved() {
    startRefresh(async () => { await loadProducts() })
  }

  async function updateState(product: NormalizedProduct, isArchived: boolean) {
    setStateProductId(product.custom_product_id)
    try {
      const result = await setBusinessCustomProductState(product.custom_product_id, {
        is_archived: isArchived,
        reason: isArchived ? '从定制产品库归档' : '从定制产品库恢复',
      })
      if (!result.ok) {
        toast.error(result.error ?? '更新定制产品状态失败')
        return
      }
      toast.success(isArchived ? '产品已归档' : '产品已恢复')
      await loadProducts()
    } catch {
      toast.error('更新定制产品状态失败，请稍后重试')
    } finally {
      setStateProductId(null)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-md border p-4 lg:flex-row lg:items-end">
        <div className="min-w-0 flex-1 space-y-2">
          <label htmlFor="custom-product-search" className="text-sm font-medium">搜索</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input id="custom-product-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索编号、名称、分组、规格或备注" className="pl-9" />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:w-[420px]">
          <div className="space-y-2">
            <span className="text-sm font-medium">产品分组</span>
            <Select value={groupFilter} onValueChange={setGroupFilter}>
              <SelectTrigger aria-label="按产品分组筛选"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部产品分组</SelectItem>
                {productGroups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <span className="text-sm font-medium">状态</span>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger aria-label="按状态筛选"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">启用中</SelectItem>
                <SelectItem value="archived">已归档</SelectItem>
                <SelectItem value={ALL}>全部状态</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2 rounded-md border bg-muted/20 p-4">
        <Button type="button" variant="outline" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />刷新
        </Button>
        <BusinessCustomProductDialog defaultCurrency="USD" productGroups={productGroups} context="library" disabled={refreshing} onCreated={handleSaved} />
      </div>

      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"><span>{error}</span><Button type="button" size="sm" variant="outline" onClick={refresh} disabled={refreshing}>重试</Button></div>}

      {refreshing && products.length === 0 ? (
        <div className="flex min-h-48 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />正在加载定制产品…</div>
      ) : filteredProducts.length === 0 ? (
        <div className="rounded-md border border-dashed px-6 py-14 text-center"><p className="font-medium">没有匹配的定制产品</p><p className="mt-1 text-sm text-muted-foreground">{products.length === 0 ? '请创建第一件全局定制产品。' : '请调整搜索词或筛选条件。'}</p></div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {filteredProducts.map((product) => {
            const statePending = stateProductId === product.custom_product_id
            return (
              <Card key={product.custom_product_id} className={product.is_archived ? 'opacity-75' : undefined}>
                <CardHeader className="pb-3">
                  <div className="flex items-start gap-3">
                    <ImagePreview src={product.image_url} alt={product.name} size="h-20 w-20" sizes="80px" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="break-words text-base">{product.name}</CardTitle>
                        {product.product_group_name && <Badge variant="outline">{product.product_group_name}</Badge>}
                        <Badge variant={product.is_archived ? 'destructive' : 'default'}>{product.is_archived ? '已归档' : '启用中'}</Badge>
                      </div>
                      <p className="mt-1 break-all text-sm text-muted-foreground">
                        {[product.code, `最新 v${product.version_no || '—'}`].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                    <div><dt className="text-xs text-muted-foreground">规格</dt><dd className="mt-0.5 break-words">{product.specification || '—'}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">销售单价</dt><dd className="mt-0.5 font-medium tabular-nums">{formatCurrency(product.default_unit_price, product.default_currency)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">版本数</dt><dd className="mt-0.5">{product.version_count}</dd></div>
                  </dl>
                  <div className="rounded-md bg-muted/40 p-3 text-sm"><div className="text-xs text-muted-foreground">备注</div><p className="mt-1 whitespace-pre-wrap break-words">{product.description || '—'}</p></div>
                  <div className="space-y-3 rounded-md border p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="font-medium">下单明细</div>
                      <div className="text-xs text-muted-foreground">累计下单数量 {product.total_order_quantity.toLocaleString('zh-CN')}</div>
                    </div>
                    {product.total_order_amounts.length > 0 && (
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm tabular-nums">
                        {product.total_order_amounts.map((total) => (
                          <span key={total.currency}>{formatCurrency(Number(total.amount), total.currency)}</span>
                        ))}
                      </div>
                    )}
                    {product.order_history.length === 0 ? (
                      <p className="text-sm text-muted-foreground">暂无下单记录</p>
                    ) : (
                      <div className="space-y-3">
                        {groupOrderHistory(product.order_history).map((group) => (
                          <div key={`${group.code}-${group.image_url ?? ''}`} className="rounded-md bg-muted/40 p-2.5">
                            <div className="flex items-start gap-3">
                              <ImagePreview src={group.image_url} alt={group.code || product.name} size="h-14 w-14" sizes="56px" />
                              <div className="min-w-0 flex-1">
                                <div className="font-medium">{group.code || '未填写编码'}</div>
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                  累计 {group.quantity.toLocaleString('zh-CN')} {group.unit || ''}
                                  {Array.from(group.amounts.entries()).map(([currency, amount]) => ` · ${formatCurrency(amount, currency)}`).join('')}
                                </div>
                              </div>
                            </div>
                            <div className="mt-2 overflow-x-auto">
                              <table className="w-full min-w-[460px] text-left text-xs">
                                <thead className="text-muted-foreground"><tr><th className="pb-1 font-medium">下单时间</th><th className="pb-1 font-medium">订单号</th><th className="pb-1 text-right font-medium">下单数量</th><th className="pb-1 text-right font-medium">下单金额</th></tr></thead>
                                <tbody>{group.orders.map((order, index) => <tr key={`${order.order_number}-${order.order_date}-${index}`} className="border-t"><td className="py-1.5">{order.order_date}</td><td className="py-1.5">{order.external_order_number || order.order_number}</td><td className="py-1.5 text-right tabular-nums">{Number(order.quantity).toLocaleString('zh-CN')} {order.unit || ''}</td><td className="py-1.5 text-right tabular-nums">{formatCurrency(Number(order.order_amount), order.currency)}</td></tr>)}</tbody>
                              </table>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 border-t pt-3">
                    <BusinessCustomProductDialog mode="version" product={product} defaultCurrency={product.default_currency} productGroups={productGroups} context="library" disabled={product.is_archived || refreshing || statePending} onCreated={handleSaved} />
                    {canManageState && <Button type="button" size="sm" variant={product.is_archived ? 'outline' : 'destructive'} disabled={refreshing || statePending} onClick={() => void updateState(product, !product.is_archived)}>{statePending ? <Loader2 className="h-4 w-4 animate-spin" /> : product.is_archived ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}{product.is_archived ? '恢复' : '归档'}</Button>}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
