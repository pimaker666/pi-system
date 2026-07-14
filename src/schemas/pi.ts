import { z } from 'zod'
import { CURRENCIES } from './product'

export const customerSnapshotSchema = z.object({
  name: z.string().trim().min(1, '客户名称不能为空'),
  company: z.string().trim().optional().nullable(),
  email: z.string().trim().email('邮箱格式错误').optional().or(z.literal('')).nullable(),
  phone: z.string().trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  country: z.string().trim().optional().nullable(),
  contact_person: z.string().trim().optional().nullable(),
})

export const piLineItemSchema = z.object({
  product_id: z.string().uuid(),
  sku: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  unit: z.string().min(1),
  unit_price: z.coerce.number().min(0),
  quantity: z.coerce.number().int('数量必须为整数').min(1, '数量至少为 1'),
})

export const piChargesSchema = z.object({
  tax_rate: z.coerce.number().min(0, '税率不能为负').max(100, '税率过高').default(0),
  shipping_fee: z.coerce.number().min(0, '运费不能为负').default(0),
  discount: z.coerce.number().min(0, '折扣不能为负').default(0),
})

export const createPiSchema = z.object({
  customer_id: z.string().uuid().optional().nullable(),
  customer_snapshot: customerSnapshotSchema,
  currency: z.enum(CURRENCIES),
  items: z.array(piLineItemSchema).min(1, '至少选择一个产品'),
  charges: piChargesSchema,
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  terms: z.string().trim().max(4000).optional().or(z.literal('')),
})

export type CreatePiInput = z.infer<typeof createPiSchema>
export type PiChargesInput = z.infer<typeof piChargesSchema>
export type CustomerSnapshotInput = z.infer<typeof customerSnapshotSchema>
