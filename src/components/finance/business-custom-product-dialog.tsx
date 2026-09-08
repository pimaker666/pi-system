'use client'

import { FormEvent, useState, useTransition } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { createBusinessCustomProduct } from '@/lib/actions/business-orders'
import type { BusinessCustomProductListItem, CurrencyCode, Profile } from '@/types'

interface BusinessCustomProductDialogProps {
  customerId: string | null
  defaultCurrency: CurrencyCode
  profileRole: Profile['role']
  disabled?: boolean
  onCreated: (product: BusinessCustomProductListItem) => void
}

const currencies: CurrencyCode[] = ['USD', 'EUR', 'CNY', 'GBP', 'JPY']

export function BusinessCustomProductDialog({
  customerId,
  defaultCurrency,
  profileRole,
  disabled = false,
  onCreated,
}: BusinessCustomProductDialogProps) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [specification, setSpecification] = useState('')
  const [unit, setUnit] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [defaultUnitPrice, setDefaultUnitPrice] = useState('')
  const [currency, setCurrency] = useState<CurrencyCode>(defaultCurrency)
  const [isShared, setIsShared] = useState(false)
  const canShare = profileRole === 'admin' || profileRole === 'finance'

  function resetForm() {
    setCode('')
    setName('')
    setDescription('')
    setSpecification('')
    setUnit('')
    setImageUrl('')
    setDefaultUnitPrice('')
    setCurrency(defaultCurrency)
    setIsShared(false)
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) setCurrency(defaultCurrency)
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (!customerId) {
      toast.error('请先选择客户')
      return
    }

    startTransition(async () => {
      const result = await createBusinessCustomProduct({
        customer_id: customerId,
        is_shared: canShare && isShared,
        initial_version: {
          code,
          name,
          description,
          specification,
          unit,
          image_url: imageUrl,
          default_unit_price: defaultUnitPrice,
          default_currency: currency,
        },
      })

      if (!result.ok || !result.product || !result.version) {
        toast.error(result.error ?? '创建定制产品失败')
        return
      }

      const created: BusinessCustomProductListItem = {
        custom_product_id: result.product.id,
        owner_customer_id: result.product.customer_id,
        is_shared: result.product.is_shared,
        is_archived: result.product.is_archived,
        version_id: result.version.id,
        version_no: result.version.version_no,
        code: result.version.code,
        name: result.version.name,
        description: result.version.description,
        specification: result.version.specification,
        unit: result.version.unit,
        image_url: result.version.image_url,
        default_unit_price: Number(result.version.default_unit_price),
        default_currency: result.version.default_currency,
      }
      onCreated(created)
      toast.success('定制产品已创建并加入订单')
      resetForm()
      setOpen(false)
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={disabled || !customerId}>
          <Plus className="h-4 w-4" />
          新建定制产品
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>新建客户定制产品</DialogTitle>
          <DialogDescription>
            产品会归属当前客户；图片暂仅支持填写公开可访问的 URL。
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="custom_product_code">编码</Label>
              <Input
                id="custom_product_code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                maxLength={100}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom_product_name">名称</Label>
              <Input
                id="custom_product_name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={300}
                required
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="custom_product_description">描述</Label>
              <Textarea
                id="custom_product_description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={4000}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="custom_product_specification">规格</Label>
              <Textarea
                id="custom_product_specification"
                value={specification}
                onChange={(event) => setSpecification(event.target.value)}
                maxLength={2000}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom_product_unit">单位</Label>
              <Input
                id="custom_product_unit"
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                maxLength={100}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom_product_image_url">图片 URL</Label>
              <Input
                id="custom_product_image_url"
                type="url"
                value={imageUrl}
                onChange={(event) => setImageUrl(event.target.value)}
                maxLength={2000}
                placeholder="https://…"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom_product_price">默认单价</Label>
              <Input
                id="custom_product_price"
                type="number"
                min="0"
                step="0.01"
                value={defaultUnitPrice}
                onChange={(event) => setDefaultUnitPrice(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>默认币种</Label>
              <Select value={currency} onValueChange={(value) => setCurrency(value as CurrencyCode)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {currencies.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {canShare && (
              <div className="flex items-start gap-3 rounded-md border p-3 sm:col-span-2">
                <input
                  id="custom_product_shared"
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-input"
                  checked={isShared}
                  onChange={(event) => setIsShared(event.target.checked)}
                />
                <div className="space-y-1">
                  <Label htmlFor="custom_product_shared">允许其他客户复用</Label>
                  <p className="text-xs text-muted-foreground">
                    开启后，其他客户的订单也能选择该定制产品；产品仍归属当前客户。
                  </p>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? '创建中…' : '创建并加入订单'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
