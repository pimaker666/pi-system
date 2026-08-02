'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const ALL = '__all__'

export interface OwnerOption {
  id: string
  label: string
}

/**
 * 管理员按归属账号筛选（客户/PI 通用）。
 * 通过 ?owner= searchParam 驱动服务端过滤，basePath 指向所在页面。
 */
export function OwnerFilter({
  owners,
  value,
  basePath,
}: {
  owners: OwnerOption[]
  value: string
  basePath: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  function setOwner(v: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (!v || v === ALL) params.delete('owner')
    else params.set('owner', v)
    const qs = params.toString()
    router.push(qs ? `${basePath}?${qs}` : basePath)
  }

  return (
    <div className="flex items-center gap-2">
      <Select value={value || ALL} onValueChange={setOwner}>
        <SelectTrigger className="w-48">
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
      {value && (
        <Button variant="ghost" size="sm" onClick={() => setOwner(ALL)}>
          <X className="h-4 w-4" />
          清除
        </Button>
      )}
    </div>
  )
}
