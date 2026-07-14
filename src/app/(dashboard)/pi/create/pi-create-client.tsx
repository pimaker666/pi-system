'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { usePiCartStore } from '@/stores/pi-cart-store'
import { createProformaInvoice } from '@/lib/actions/pi'
import { calcPiTotals } from '@/lib/calc'
import { formatCurrency } from '@/lib/utils'
import { ProductSelector } from '@/components/products/product-selector'
import { CustomerCombobox } from '@/components/customers/customer-combobox'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Customer, CustomerGroup, Product, CustomerSnapshot } from '@/types'

interface PiCreateClientProps {
  products: Product[]
  customers: Customer[]
  groups: CustomerGroup[]
  defaultTerms: string
}

function toSnapshot(c: Customer): CustomerSnapshot {
  return {
    name: c.name,
    company: c.company,
    email: c.email,
    phone: c.phone,
    address: c.address,
    country: c.country,
    contact_person: c.contact_person,
  }
}

export function PiCreateClient({
  products,
  customers,
  groups,
  defaultTerms,
}: PiCreateClientProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [terms, setTerms] = useState(defaultTerms)

  const { items, charges, currency, notes, setCharges, setNotes, reset } = usePiCartStore()

  const totals = useMemo(() => calcPiTotals(items, charges), [items, charges])

  function handleSubmit() {
    if (!customer) {
      toast.error('请先选择客户')
      return
    }
    if (items.length === 0) {
      toast.error('请至少选择一个产品')
      return
    }

    startTransition(async () => {
      const result = await createProformaInvoice({
        customer_id: customer.id,
        customer_snapshot: toSnapshot(customer),
        currency,
        items: items.map((i) => ({
          product_id: i.product_id,
          sku: i.sku,
          name: i.name,
          description: i.description,
          unit: i.unit,
          unit_price: i.unit_price,
          quantity: i.quantity,
        })),
        charges,
        notes,
        terms,
      })

      if (result.ok && result.id) {
        toast.success(`PI ${result.pi_number} 已生成`)
        reset()
        router.push(`/pi/${result.id}`)
      } else {
        toast.error(result.error ?? '生成失败')
      }
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. 选择客户</CardTitle>
        </CardHeader>
        <CardContent>
          <CustomerCombobox
            customers={customers}
            groups={groups}
            value={customer}
            onChange={setCustomer}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. 选择产品</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductSelector products={products.filter((p) => p.is_active)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">3. 费用与条款</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="tax_rate">税率 (%)</Label>
              <Input
                id="tax_rate"
                type="number"
                step="0.01"
                min={0}
                value={charges.tax_rate}
                onChange={(e) => setCharges({ tax_rate: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="shipping_fee">运费 ({currency})</Label>
              <Input
                id="shipping_fee"
                type="number"
                step="0.01"
                min={0}
                value={charges.shipping_fee}
                onChange={(e) => setCharges({ shipping_fee: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="discount">折扣 ({currency})</Label>
              <Input
                id="discount"
                type="number"
                step="0.01"
                min={0}
                value={charges.discount}
                onChange={(e) => setCharges({ discount: Number(e.target.value) || 0 })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="terms">条款</Label>
            <Textarea
              id="terms"
              rows={3}
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="notes">备注</Label>
            <Textarea
              id="notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1 text-sm">
            <div className="flex gap-8">
              <span className="text-muted-foreground">小计</span>
              <span>{formatCurrency(totals.subtotal, currency)}</span>
            </div>
            <div className="flex gap-8">
              <span className="text-muted-foreground">税额</span>
              <span>{formatCurrency(totals.tax_amount, currency)}</span>
            </div>
            <div className="flex gap-8 text-lg font-semibold">
              <span>总计</span>
              <span>{formatCurrency(totals.total, currency)}</span>
            </div>
          </div>
          <Button size="lg" onClick={handleSubmit} disabled={pending}>
            {pending ? '生成中…' : '生成 PI'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
