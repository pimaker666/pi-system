'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DateRangePicker } from '@/components/shared/date-range-picker'
import { Input } from '@/components/ui/input'
import { MultiSelectFilter } from '@/components/shared/multi-select-filter'
import { formatCountryName } from '@/lib/country-flags'
import type { CustomerGroup } from '@/types'
import type { OwnerOption } from '@/components/shared/owner-filter'

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
  amountMin,
  amountMax,
  lastOrderFrom,
  lastOrderTo,
}: {
  groups: CustomerGroup[]
  countries: string[]
  owners?: OwnerOption[]
  isAdmin?: boolean
  q: string
  group: string[]
  country: string[]
  owner: string[]
  amountMin: string
  amountMax: string
  lastOrderFrom: string
  lastOrderTo: string
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
      if (!value) params.delete(key)
      else params.set(key, value)
    })
  }

  function setParamList(key: string, values: string[]) {
    pushParams((params) => {
      if (values.length === 0) params.delete(key)
      else params.set(key, values.join(','))
    })
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    setParam('q', keyword.trim())
  }

  const hasFilter = Boolean(q || group.length || country.length || owner.length || amountMin || amountMax || lastOrderFrom || lastOrderTo)

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

      <MultiSelectFilter
        allLabel="全部分组"
        options={[
          { value: NO_GROUP, label: '未分组' },
          ...groups.map((g) => ({ value: g.id, label: g.name })),
        ]}
        selected={group}
        onChange={(values) => setParamList('group', values)}
        className="w-40"
      />

      <MultiSelectFilter
        allLabel="全部国家"
        options={countries.map((c) => ({ value: c, label: formatCountryName(c) }))}
        selected={country}
        onChange={(values) => setParamList('country', values)}
        className="w-40"
      />

      <Input type="number" min="0" defaultValue={amountMin} placeholder="近一年 CNY 最低" className="w-36" onBlur={(event) => setParam('amountMin', event.target.value)} />
      <Input type="number" min="0" defaultValue={amountMax} placeholder="近一年 CNY 最高" className="w-36" onBlur={(event) => setParam('amountMax', event.target.value)} />
      <DateRangePicker
        from={lastOrderFrom}
        to={lastOrderTo}
        nameFrom="lastOrderFrom"
        nameTo="lastOrderTo"
        className="w-64"
        onChange={({ from, to }) => pushParams((params) => {
          if (from) params.set('lastOrderFrom', from)
          else params.delete('lastOrderFrom')
          if (to) params.set('lastOrderTo', to)
          else params.delete('lastOrderTo')
        })}
      />

      {isAdmin && (
        <MultiSelectFilter
          allLabel="全部账号"
          options={owners.map((o) => ({ value: o.id, label: o.label }))}
          selected={owner}
          onChange={(values) => setParamList('owner', values)}
          className="w-44"
        />
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
