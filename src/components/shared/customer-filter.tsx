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

/**
 * 按客户筛选 PI。通过 ?cust= searchParam 驱动服务端过滤，
 * 选项为历史 PI 中出现过的客户名称（快照名），basePath 指向所在页面。
 */
export function CustomerFilter({
  customers,
  value,
  basePath,
}: {
  customers: string[]
  value: string
  basePath: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  function setCustomer(v: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (!v || v === ALL) params.delete('cust')
    else params.set('cust', v)
    const qs = params.toString()
    router.push(qs ? `${basePath}?${qs}` : basePath)
  }

  return (
    <div className="flex items-center gap-2">
      <Select value={value || ALL} onValueChange={setCustomer}>
        <SelectTrigger className="w-52">
          <SelectValue placeholder="全部客户" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>全部客户</SelectItem>
          {customers.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value && (
        <Button variant="ghost" size="sm" onClick={() => setCustomer(ALL)}>
          <X className="h-4 w-4" />
          清除
        </Button>
      )}
    </div>
  )
}
