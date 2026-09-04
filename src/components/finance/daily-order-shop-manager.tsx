'use client'

import { FormEvent, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  deleteDailyOrderShopGroup,
  saveDailyOrderShop,
  saveDailyOrderShopGroup,
} from '@/lib/actions/daily-orders'
import { displayProfileName } from '@/lib/utils'
import type { DailyOrderShop, DailyOrderShopGroup, Profile } from '@/types'

interface ShopRow extends DailyOrderShop {
  salespersonIds: string[]
}

interface Props {
  shops: ShopRow[]
  groups: DailyOrderShopGroup[]
  salespeople: Pick<Profile, 'id' | 'full_name' | 'email' | 'chinese_name'>[]
}

export function DailyOrderShopManager({ shops, groups, salespeople }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function submitShop(event: FormEvent<HTMLFormElement>, shop?: ShopRow) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    startTransition(async () => {
      const groupId = data.get('group_id')
      const result = await saveDailyOrderShop({
        id: shop?.id,
        name: data.get('name'),
        group_id: typeof groupId === 'string' && groupId !== 'ungrouped' ? groupId : null,
        is_active: data.get('is_active') === 'on',
        default_currency: data.get('default_currency'),
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

  function submitGroup(event: FormEvent<HTMLFormElement>, group?: DailyOrderShopGroup) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    startTransition(async () => {
      const result = await saveDailyOrderShopGroup({ id: group?.id, name: data.get('name') })
      if (!result.ok) {
        toast.error(result.error ?? '保存失败')
        return
      }
      toast.success(group ? '分组名称已更新' : '分组已创建')
      if (!group) form.reset()
      router.refresh()
    })
  }

  function deleteGroup(group: DailyOrderShopGroup) {
    if (!window.confirm(`确定删除分组“${group.name}”吗？分组内店铺会保留并移至未分组。`)) return
    startTransition(async () => {
      const result = await deleteDailyOrderShopGroup(group.id)
      if (!result.ok) {
        toast.error(result.error ?? '删除失败')
        return
      }
      toast.success('分组已删除')
      router.refresh()
    })
  }

  const shopForm = (shop?: ShopRow) => (
    <form key={shop?.id ?? 'new'} className="space-y-4" onSubmit={(event) => submitShop(event, shop)}>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,200px)_minmax(0,120px)_auto] md:items-end">
        <div className="space-y-2">
          <Label>店铺名称</Label>
          <Input name="name" defaultValue={shop?.name ?? ''} required maxLength={100} />
        </div>
        <div className="space-y-2">
          <Label>所属分组</Label>
          <Select name="group_id" defaultValue={shop?.group_id ?? 'ungrouped'}>
            <SelectTrigger><SelectValue placeholder="选择分组" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ungrouped">未分组</SelectItem>
              {groups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>默认币种</Label>
          <Select name="default_currency" defaultValue={shop?.default_currency ?? 'CNY'}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="CNY">CNY</SelectItem>
              <SelectItem value="USD">USD</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="flex h-10 items-center gap-2 text-sm">
          <input name="is_active" type="checkbox" defaultChecked={shop?.is_active ?? true} />启用
        </label>
      </div>
      <div className="space-y-2">
        <Label>分配业务员</Label>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {salespeople.map((person) => (
            <label key={person.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
              <input
                name="salesperson_ids"
                type="checkbox"
                value={person.id}
                defaultChecked={shop?.salespersonIds.includes(person.id)}
              />
              {displayProfileName(person)}
            </label>
          ))}
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>{pending ? '保存中…' : '保存'}</Button>
      </div>
    </form>
  )

  const shopSection = (key: string, title: string, sectionShops: ShopRow[]) => (
    <section className="space-y-3" key={key}>
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="text-sm text-muted-foreground">{sectionShops.length} 个店铺</span>
      </div>
      {sectionShops.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">该分组暂无店铺</div>
      ) : sectionShops.map((shop) => (
        <Card key={shop.id}>
          <CardHeader><CardTitle className="text-base">{shop.name}</CardTitle></CardHeader>
          <CardContent>{shopForm(shop)}</CardContent>
        </Card>
      ))}
    </section>
  )

  const ungroupedShops = shops.filter((shop) => !shop.group_id || !groups.some((group) => group.id === shop.group_id))

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-base">店铺分组</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => submitGroup(event)}>
            <Input name="name" placeholder="输入新分组名称" required maxLength={100} />
            <Button type="submit" disabled={pending}>新增分组</Button>
          </form>
          {groups.length > 0 && (
            <div className="grid gap-2 lg:grid-cols-2">
              {groups.map((group) => (
                <form key={group.id} className="flex gap-2 rounded-md border p-2" onSubmit={(event) => submitGroup(event, group)}>
                  <Input name="name" defaultValue={group.name} required maxLength={100} aria-label={`${group.name} 分组名称`} />
                  <Button type="submit" variant="outline" disabled={pending}>保存</Button>
                  <Button type="button" variant="destructive" disabled={pending} onClick={() => deleteGroup(group)}>删除</Button>
                </form>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">删除分组不会删除店铺，原分组内店铺会自动移至“未分组”。</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">新增店铺</CardTitle></CardHeader>
        <CardContent>{shopForm()}</CardContent>
      </Card>

      {groups.map((group) => shopSection(group.id, group.name, shops.filter((shop) => shop.group_id === group.id)))}
      {shopSection('ungrouped', '未分组', ungroupedShops)}
    </div>
  )
}
