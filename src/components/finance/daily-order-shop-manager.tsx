'use client'

import { FormEvent, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { saveDailyOrderShop } from '@/lib/actions/daily-orders'
import type { DailyOrderShop, Profile } from '@/types'

interface ShopRow extends DailyOrderShop { salespersonIds: string[] }

export function DailyOrderShopManager({ shops, salespeople }: {
  shops: ShopRow[]
  salespeople: Pick<Profile, 'id' | 'full_name' | 'email'>[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function submit(event: FormEvent<HTMLFormElement>, shop?: ShopRow) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    startTransition(async () => {
      const result = await saveDailyOrderShop({
        id: shop?.id,
        name: data.get('name'),
        is_active: data.get('is_active') === 'on',
        salesperson_ids: data.getAll('salesperson_ids'),
      })
      if (!result.ok) {
        toast.error(result.error ?? '保存失败')
        return
      }
      toast.success(shop ? '店铺设置已更新' : '店铺已创建')
      if (!shop) form.reset()
      router.refresh()
    })
  }

  const form = (shop?: ShopRow) => (
    <form key={shop?.id ?? 'new'} className="space-y-4" onSubmit={(event) => submit(event, shop)}>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="space-y-2"><Label>店铺名称</Label><Input name="name" defaultValue={shop?.name ?? ''} required maxLength={100} /></div>
        <label className="flex h-10 items-center gap-2 text-sm"><input name="is_active" type="checkbox" defaultChecked={shop?.is_active ?? true} />启用</label>
      </div>
      <div className="space-y-2"><Label>分配业务员</Label><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{salespeople.map((person) => <label key={person.id} className="flex items-center gap-2 rounded-md border p-2 text-sm"><input name="salesperson_ids" type="checkbox" value={person.id} defaultChecked={shop?.salespersonIds.includes(person.id)} />{person.full_name || person.email}</label>)}</div></div>
      <div className="flex justify-end"><Button type="submit" disabled={pending}>{pending ? '保存中…' : '保存'}</Button></div>
    </form>
  )

  return <div className="space-y-4"><Card><CardHeader><CardTitle className="text-base">新增店铺</CardTitle></CardHeader><CardContent>{form()}</CardContent></Card>{shops.map((shop) => <Card key={shop.id}><CardHeader><CardTitle className="text-base">{shop.name}</CardTitle></CardHeader><CardContent>{form(shop)}</CardContent></Card>)}</div>
}
