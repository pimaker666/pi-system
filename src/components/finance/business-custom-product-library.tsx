'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  Archive,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
} from 'lucide-react'
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
  CurrencyCode,
  Customer,
  Profile,
} from '@/types'
import { BusinessCustomProductDialog } from './business-custom-product-dialog'

const ALL = '__all__'

type NormalizedProduct = BusinessCustomProductListItem & {
  owner_customer_name: string
  version_count: number
  estimated_unit_cost: number | null
  updated_at: string
}

interface BusinessCustomProductLibraryProps {
  initialProducts: BusinessCustomProductLibraryItem[]
  customers: Customer[]
  profileId: string
  profileRole: Profile['role']
  initialError?: string | null
}

function customerLabel(customer: Pick<Customer, 'name' | 'company'>) {
  return customer.company
    ? `${customer.name} · ${customer.company}`
    : customer.name
}

function normalizeProduct(
  raw: BusinessCustomProductLibraryItem,
): NormalizedProduct {
  const row = raw as unknown as Record<string, unknown>
  const currency = row.default_currency as CurrencyCode | undefined
  return {
    custom_product_id: String(row.custom_product_id ?? ''),
    owner_customer_id: String(row.customer_id ?? row.owner_customer_id ?? ''),
    owner_customer_name: String(
      row.customer_name ?? row.owner_customer_name ?? '',
    ),
    is_shared: Boolean(row.is_shared),
    is_archived: Boolean(row.is_archived),
    version_id: String(row.latest_version_id ?? row.version_id ?? ''),
    version_no: Number(row.latest_version_no ?? row.version_no ?? 0),
    version_count: Number(row.version_count ?? 1),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    description: typeof row.description === 'string' ? row.description : null,
    specification:
      typeof row.specification === 'string' ? row.specification : null,
    unit: String(row.unit ?? ''),
    image_url: typeof row.image_url === 'string' ? row.image_url : null,
    default_unit_price: Number(row.default_unit_price ?? 0),
    default_currency: currency ?? 'USD',
    estimated_unit_cost:
      row.estimated_unit_cost == null ? null : Number(row.estimated_unit_cost),
    updated_at: String(row.updated_at ?? ''),
  }
}

function latestProducts(rows: BusinessCustomProductLibraryItem[]) {
  const products = new Map<string, NormalizedProduct>()
  for (const rawRow of rows) {
    const row = normalizeProduct(rawRow)
    const current = products.get(row.custom_product_id)
    if (!current || row.version_no > current.version_no) {
      products.set(row.custom_product_id, row)
    } else if (row.version_count > current.version_count) {
      current.version_count = row.version_count
    }
  }
  return [...products.values()].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  )
}

export function BusinessCustomProductLibrary({
  initialProducts,
  customers,
  profileId,
  profileRole,
  initialError = null,
}: BusinessCustomProductLibraryProps) {
  const canManageState = profileRole === 'admin' || profileRole === 'finance'
  const manageableCustomers = useMemo(
    () =>
      canManageState
        ? customers
        : customers.filter((customer) => customer.created_by === profileId),
    [canManageState, customers, profileId],
  )
  const manageableCustomerIds = useMemo(
    () => new Set(manageableCustomers.map((customer) => customer.id)),
    [manageableCustomers],
  )
  const [products, setProducts] = useState(initialProducts)
  const [error, setError] = useState(initialError)
  const [query, setQuery] = useState('')
  const [customerFilter, setCustomerFilter] = useState(ALL)
  const [sharingFilter, setSharingFilter] = useState(ALL)
  const [statusFilter, setStatusFilter] = useState('active')
  const [createCustomerId, setCreateCustomerId] = useState(
    manageableCustomers[0]?.id ?? '',
  )
  const [refreshing, startRefresh] = useTransition()
  const [stateProductId, setStateProductId] = useState<string | null>(null)

  const customerNames = useMemo(
    () =>
      new Map(
        customers.map((customer) => [customer.id, customerLabel(customer)]),
      ),
    [customers],
  )
  const normalizedProducts = useMemo(() => latestProducts(products), [products])
  const filteredProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return normalizedProducts.filter((product) => {
      const ownerName =
        product.owner_customer_name ||
        customerNames.get(product.owner_customer_id) ||
        ''
      const matchesQuery =
        !normalizedQuery ||
        [
          product.code,
          product.name,
          product.specification,
          product.description,
          ownerName,
        ]
          .filter(Boolean)
          .some((value) =>
            String(value).toLocaleLowerCase().includes(normalizedQuery),
          )
      const matchesCustomer =
        customerFilter === ALL || product.owner_customer_id === customerFilter
      const matchesSharing =
        sharingFilter === ALL ||
        (sharingFilter === 'shared' ? product.is_shared : !product.is_shared)
      const matchesStatus =
        statusFilter === ALL ||
        (statusFilter === 'active' ? !product.is_archived : product.is_archived)
      return matchesQuery && matchesCustomer && matchesSharing && matchesStatus
    })
  }, [
    customerFilter,
    customerNames,
    normalizedProducts,
    query,
    sharingFilter,
    statusFilter,
  ])

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
      const ok = await loadProducts()
      if (ok) toast.success('定制产品库已刷新')
    })
  }

  function handleSaved() {
    startRefresh(async () => {
      await loadProducts()
    })
  }

  async function updateState(
    product: NormalizedProduct,
    patch: { is_shared?: boolean; is_archived?: boolean },
  ) {
    setStateProductId(product.custom_product_id)
    try {
      const nextShared = patch.is_shared ?? product.is_shared
      const nextArchived = patch.is_archived ?? product.is_archived
      const result = await setBusinessCustomProductState(
        product.custom_product_id,
        {
          is_shared: nextShared,
          is_archived: nextArchived,
          reason:
            patch.is_archived == null
              ? nextShared
                ? '在定制产品库中允许其他客户复用'
                : '在定制产品库中改为客户专属'
              : nextArchived
                ? '从定制产品库归档'
                : '从定制产品库恢复',
        },
      )
      if (!result.ok) {
        toast.error(result.error ?? '更新定制产品状态失败')
        return
      }
      toast.success(
        patch.is_archived == null
          ? nextShared
            ? '已设为共享产品'
            : '已设为客户专属'
          : nextArchived
            ? '产品已归档'
            : '产品已恢复',
      )
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
          <label
            htmlFor="custom-product-search"
            className="text-sm font-medium"
          >
            搜索
          </label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="custom-product-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索编号、名称、客户、规格或备注"
              className="pl-9"
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3 lg:w-[620px]">
          <div className="space-y-2">
            <span className="text-sm font-medium">客户</span>
            <Select value={customerFilter} onValueChange={setCustomerFilter}>
              <SelectTrigger aria-label="按客户筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部客户</SelectItem>
                {customers.map((customer) => (
                  <SelectItem key={customer.id} value={customer.id}>
                    {customerLabel(customer)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <span className="text-sm font-medium">共享范围</span>
            <Select value={sharingFilter} onValueChange={setSharingFilter}>
              <SelectTrigger aria-label="按共享范围筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部范围</SelectItem>
                <SelectItem value="shared">共享</SelectItem>
                <SelectItem value="exclusive">客户专属</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <span className="text-sm font-medium">状态</span>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger aria-label="按启用状态筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">启用中</SelectItem>
                <SelectItem value="archived">已归档</SelectItem>
                <SelectItem value={ALL}>全部状态</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="flex flex-col justify-between gap-3 rounded-md border bg-muted/20 p-4 sm:flex-row sm:items-end">
        <div className="min-w-0 space-y-2 sm:max-w-md sm:flex-1">
          <span className="text-sm font-medium">新产品归属客户</span>
          <Select value={createCustomerId} onValueChange={setCreateCustomerId}>
            <SelectTrigger aria-label="选择新产品归属客户">
              <SelectValue placeholder="请选择客户" />
            </SelectTrigger>
            <SelectContent>
              {manageableCustomers.map((customer) => (
                <SelectItem key={customer.id} value={customer.id}>
                  {customerLabel(customer)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            业务员和主管只能为自己负责的客户创建定制产品。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={refresh}
            disabled={refreshing}
          >
            <RefreshCw
              className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
            />
            刷新
          </Button>
          <BusinessCustomProductDialog
            customerId={createCustomerId || null}
            defaultCurrency="USD"
            profileRole={profileRole}
            context="library"
            disabled={refreshing || manageableCustomers.length === 0}
            onCreated={handleSaved}
          />
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
        >
          <span>{error}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={refresh}
            disabled={refreshing}
          >
            重试
          </Button>
        </div>
      )}

      {refreshing && products.length === 0 ? (
        <div className="flex min-h-48 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在加载定制产品…
        </div>
      ) : filteredProducts.length === 0 ? (
        <div className="rounded-md border border-dashed px-6 py-14 text-center">
          <p className="font-medium">没有匹配的定制产品</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {products.length === 0
              ? '请先选择客户并创建第一件定制产品。'
              : '请调整搜索词或筛选条件。'}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {filteredProducts.map((product) => {
            const statePending = stateProductId === product.custom_product_id
            const canCreateVersion = manageableCustomerIds.has(
              product.owner_customer_id,
            )
            const ownerName =
              product.owner_customer_name ||
              customerNames.get(product.owner_customer_id) ||
              '未知客户'
            return (
              <Card
                key={product.custom_product_id}
                className={product.is_archived ? 'opacity-75' : undefined}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start gap-3">
                    <ImagePreview
                      src={product.image_url}
                      alt={product.name}
                      size="h-20 w-20"
                      sizes="80px"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="break-words text-base">
                          {product.name}
                        </CardTitle>
                        <Badge
                          variant={product.is_shared ? 'secondary' : 'outline'}
                        >
                          {product.is_shared ? '共享' : '客户专属'}
                        </Badge>
                        <Badge
                          variant={
                            product.is_archived ? 'destructive' : 'default'
                          }
                        >
                          {product.is_archived ? '已归档' : '启用中'}
                        </Badge>
                      </div>
                      <p className="mt-1 break-all text-sm text-muted-foreground">
                        {product.code} · 最新 v{product.version_no}
                      </p>
                      <p className="mt-1 truncate text-sm">{ownerName}</p>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-xs text-muted-foreground">规格</dt>
                      <dd className="mt-0.5 break-words">
                        {product.specification || '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">单位</dt>
                      <dd className="mt-0.5">{product.unit}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">币种</dt>
                      <dd className="mt-0.5">{product.default_currency}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        参考售价
                      </dt>
                      <dd className="mt-0.5 font-medium tabular-nums">
                        {formatCurrency(
                          product.default_unit_price,
                          product.default_currency,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        预计成本
                      </dt>
                      <dd className="mt-0.5 tabular-nums">
                        {product.estimated_unit_cost == null
                          ? '—'
                          : formatCurrency(
                              product.estimated_unit_cost,
                              product.default_currency,
                            )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">版本数</dt>
                      <dd className="mt-0.5">{product.version_count}</dd>
                    </div>
                  </dl>
                  <div className="rounded-md bg-muted/40 p-3 text-sm">
                    <div className="text-xs text-muted-foreground">备注</div>
                    <p className="mt-1 whitespace-pre-wrap break-words">
                      {product.description || '—'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 border-t pt-3">
                    <BusinessCustomProductDialog
                      mode="version"
                      product={product}
                      customerId={product.owner_customer_id}
                      defaultCurrency={product.default_currency}
                      profileRole={profileRole}
                      context="library"
                      disabled={
                        !canCreateVersion ||
                        product.is_archived ||
                        refreshing ||
                        statePending
                      }
                      onCreated={handleSaved}
                    />
                    {canManageState && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={refreshing || statePending}
                          onClick={() =>
                            void updateState(product, {
                              is_shared: !product.is_shared,
                            })
                          }
                        >
                          {statePending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Share2 className="h-4 w-4" />
                          )}
                          {product.is_shared ? '改为专属' : '允许共享'}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={
                            product.is_archived ? 'outline' : 'destructive'
                          }
                          disabled={refreshing || statePending}
                          onClick={() =>
                            void updateState(product, {
                              is_archived: !product.is_archived,
                            })
                          }
                        >
                          {statePending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : product.is_archived ? (
                            <RotateCcw className="h-4 w-4" />
                          ) : (
                            <Archive className="h-4 w-4" />
                          )}
                          {product.is_archived ? '恢复' : '归档'}
                        </Button>
                      </>
                    )}
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
