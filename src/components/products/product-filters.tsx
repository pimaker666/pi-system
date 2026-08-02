'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ProductGroup } from '@/types'

const ALL = '__all__'
const NO_GROUP = '__none__'

export function ProductFilters({
  categories,
  groups,
  q,
  category,
  group,
}: {
  categories: string[]
  groups: ProductGroup[]
  q: string
  category: string
  group: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [keyword, setKeyword] = useState(q)

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (!value || value === ALL) params.delete(key)
    else params.set(key, value)
    const qs = params.toString()
    router.push(qs ? `/products?${qs}` : '/products')
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    setParam('q', keyword.trim())
  }

  const hasFilter = Boolean(q || category || group)

  return (
    <div className="flex flex-wrap items-center gap-3">
      <form onSubmit={submitSearch} className="flex gap-2">
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索产品名/SKU…"
          className="w-64"
        />
        <Button type="submit" variant="outline" size="icon">
          <Search className="h-4 w-4" />
        </Button>
      </form>

      <Select value={category || ALL} onValueChange={(v) => setParam('category', v)}>
        <SelectTrigger className="w-48">
          <SelectValue placeholder="全部品类" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部品类</SelectItem>
          {categories.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={group || ALL} onValueChange={(v) => setParam('group', v)}>
        <SelectTrigger className="w-48">
          <SelectValue placeholder="全部分组" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部分组</SelectItem>
          <SelectItem value={NO_GROUP}>未分组</SelectItem>
          {groups.map((g) => (
            <SelectItem key={g.id} value={g.id}>
              {g.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasFilter && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setKeyword('')
            router.push('/products')
          }}
        >
          <X className="h-4 w-4" />
          清除筛选
        </Button>
      )}
    </div>
  )
}
