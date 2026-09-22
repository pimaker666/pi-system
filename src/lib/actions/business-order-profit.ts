'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireFinanceAccess } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

export interface BusinessOrderProfitRow {
  order_id: string
  profit_period: string
  order_date: string
  order_number: string
  external_order_number: string | null
  shop_name: string | null
  salesperson_name: string | null
  currency: 'CNY' | 'USD'
  received_amount: number
  product_cost: number
  freight_cost: number
  commission_amount: number
  fee_amount: number
  profit_amount: number
}

export async function getBusinessOrderProfitRows(input: {
  period?: string
  salespersonIds?: string[]
  shopIds?: string[]
}): Promise<BusinessOrderProfitRow[]> {
  await requireFinanceAccess()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('get_business_order_profit_rows', {
    p_period: input.period ? `${input.period}-01` : null,
    p_salesperson_ids: input.salespersonIds?.length ? input.salespersonIds : null,
    p_shop_ids: input.shopIds?.length ? input.shopIds : null,
  })
  if (error) throw new Error(`利润核算读取失败：${error.message}`)
  const rows = (data ?? []) as BusinessOrderProfitRow[]
  return rows.map((row) => ({
    ...row,
    profit_period: String(row.profit_period).slice(0, 7),
    received_amount: Number(row.received_amount),
    product_cost: Number(row.product_cost),
    freight_cost: Number(row.freight_cost),
    commission_amount: Number(row.commission_amount),
    fee_amount: Number(row.fee_amount),
    profit_amount: Number(row.profit_amount),
  })) as BusinessOrderProfitRow[]
}

const feeSchema = z.object({
  businessOrderId: z.string().uuid(),
  feeAmount: z.coerce.number().min(0).max(999999999999),
})

export async function saveBusinessOrderProfitFee(input: {
  businessOrderId: string
  feeAmount: number
}) {
  const profile = await requireFinanceAccess()
  const parsed = feeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: '手续费金额无效' }
  const supabase = await createClient()
  const { error } = await supabase.from('finance_business_order_profit_fees').upsert({
    business_order_id: parsed.data.businessOrderId,
    fee_amount: parsed.data.feeAmount,
    updated_by: profile.id,
  })
  if (error) return { ok: false, error: error.message }
  revalidatePath('/finance/profit')
  return { ok: true }
}
