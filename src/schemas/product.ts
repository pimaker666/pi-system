import { z } from 'zod'

export const CURRENCIES = ['USD', 'EUR', 'CNY', 'GBP', 'JPY'] as const

export const productSchema = z.object({
  sku: z
    .string()
    .trim()
    .min(1, 'SKU 不能为空')
    .max(64, 'SKU 过长'),
  name: z
    .string()
    .trim()
    .min(1, '产品名称不能为空')
    .max(200, '名称过长'),
  description: z.string().trim().max(2000).optional().or(z.literal('')),
  unit: z.string().trim().min(1, '单位不能为空').max(32).default('pcs'),
  unit_price: z.coerce
    .number({ invalid_type_error: '请输入有效价格' })
    .min(0, '价格不能为负'),
  currency: z.enum(CURRENCIES).default('USD'),
  image_url: z.string().url('图片地址无效').optional().or(z.literal('')),
  is_active: z.boolean().default(true),
})

export type ProductInput = z.infer<typeof productSchema>
