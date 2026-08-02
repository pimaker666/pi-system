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
import type { CustomerGroup } from '@/types'
import type { OwnerOption } from '@/components/shared/owner-filter'

const ALL = '__all__'
const NO_GROUP = '__none__'

export function CustomerFilters({
  groups,
  countries,
  owners = [],
  isAdmin = false,
  q,
  group,
  country,
  owner,
}: {
  groups: CustomerGroup[]
  countries: string[]
  owners?: OwnerOption[]
  isAdmin?: boolean
  q: string
  group: string
  country: string
  owner: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [keyword, setKeyword] = useState(q)

  function pushParams(mutate: (p: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString())
    mutate(params)
    const qs = params.toString()
    router.push(qs ? `/customers?${qs}` : '/customers')
  }

  function setParam(key: string, value: string) {
    pushParams((params) => {
      if (!value || value === ALL) params.delete(key)
      else params.set(key, value)
    })
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    setParam('q', keyword.trim())
  }

  const hasFilter = Boolean(q || group || country || owner)

  return (
    <div className="flex flex-wrap items-center gap-3">
      <form onSubmit={submitSearch} className="flex gap-2">
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索客户名/公司/邮箱/电话…"
          className="w-64"
        />
        <Button type="submit" variant="outline" size="icon">
          <Search className="h-4 w-4" />
        </Button>
      </form>

      <Select value={group || ALL} onValueChange={(v) => setParam('group', v)}>
        <SelectTrigger className="w-40">
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

      <Select value={country || ALL} onValueChange={(v) => setParam('country', v)}>
        <SelectTrigger className="w-40">
          <SelectValue placeholder="全部国家" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部国家</SelectItem>
          {countries.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isAdmin && (
        <Select value={owner || ALL} onValueChange={(v) => setParam('owner', v)}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="全部账号" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部账号</SelectItem>
            {owners.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {hasFilter && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setKeyword('')
            router.push('/customers')
          }}
        >
          <X className="h-4 w-4" />
          清除筛选
        </Button>
      )}
    </div>
  )
}
