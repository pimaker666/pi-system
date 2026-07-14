'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createCustomer, updateCustomer } from '@/lib/actions/customers'
import type { Customer, CustomerGroup } from '@/types'

const NO_GROUP = '__none__'

interface CustomerFormProps {
  customer?: Customer
  groups: CustomerGroup[]
  onSuccess?: (id?: string) => void
}

export function CustomerFormFields({ customer, groups, onSuccess }: CustomerFormProps) {
  const [pending, startTransition] = useTransition()
  const [groupId, setGroupId] = useState(customer?.group_id ?? NO_GROUP)

  function handleSubmit(formData: FormData) {
    formData.set('group_id', groupId === NO_GROUP ? '' : groupId)
    startTransition(async () => {
      const result = customer
        ? await updateCustomer(customer.id, formData)
        : await createCustomer(formData)
      if (result.ok) {
        toast.success(customer ? '客户已更新' : '客户已创建')
        onSuccess?.(result.id)
      } else {
        toast.error(result.error ?? '保存失败')
      }
    })
  }

  return (
    <form action={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="name">客户名称 *</Label>
          <Input id="name" name="name" defaultValue={customer?.name} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="company">公司</Label>
          <Input id="company" name="company" defaultValue={customer?.company ?? ''} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="contact_person">联系人</Label>
          <Input
            id="contact_person"
            name="contact_person"
            defaultValue={customer?.contact_person ?? ''}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="country">国家/地区</Label>
          <Input id="country" name="country" defaultValue={customer?.country ?? ''} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="email">邮箱</Label>
          <Input id="email" name="email" type="email" defaultValue={customer?.email ?? ''} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">电话</Label>
          <Input id="phone" name="phone" defaultValue={customer?.phone ?? ''} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="address">地址</Label>
        <Textarea id="address" name="address" rows={2} defaultValue={customer?.address ?? ''} />
      </div>

      <div className="space-y-2">
        <Label>分组</Label>
        <Select value={groupId} onValueChange={setGroupId}>
          <SelectTrigger>
            <SelectValue placeholder="选择分组" />
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

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? '保存中…' : '保存'}
      </Button>
    </form>
  )
}
