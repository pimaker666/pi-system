import { z } from 'zod'

export const CURRENCIES = ['USD', 'EUR', 'CNY', 'GBP', 'JPY'] as const

export const KNOWN_CATEGORIES = [
  'Facial Mask',
  'Eye Mask',
  'Wrapping Mask',
  'Toner Pads',
  'FACIAL SERUM',
  'FACIAL CREAM',
  'EYE CREAM',
  'FACIAL TONER',
  'CLEANSER',
  'HAIR CARE',
  'BODY CARE',
  'SUNSCREEN',
  'EXFOLIATING',
  'BALM',
  'Skincare',
] as const

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
  specification: z.string().trim().max(200).optional().or(z.literal('')),
  weight_g: z
    .preprocess(
      (v) => (v === '' || v === null || v === undefined ? null : Number(v)),
      z
        .number({ invalid_type_error: '克重必须是数字' })
        .min(0, '克重不能为负')
        .nullable(),
    )
    .optional(),
  unit: z.string().trim().min(1, '单位不能为空').max(32).default('pcs'),
  unit_price: z.coerce
    .number({ invalid_type_error: '请输入有效价格' })
    .min(0, '价格不能为负'),
  currency: z.enum(CURRENCIES).default('USD'),
  image_url: z.string().url('图片地址无效').optional().or(z.literal('')),
  category: z.string().trim().max(100).optional().or(z.literal('')),
  group_id: z.string().uuid().optional().nullable().or(z.literal('')),
  is_active: z.boolean().default(true),
})

export const productFinancialSchema = z.object({
  product_id: z.string().uuid('产品 ID 无效'),
  financial_number: z.string().trim().max(100, '财务编号不能超过 100 个字符'),
  product_name: z.string().trim().max(200, '产品名称不能超过 200 个字符'),
  cost: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? null : Number(value)),
    z.number({ invalid_type_error: '成本必须是数字' }).min(0, '成本不能为负').nullable(),
  ),
})

export const productGroupSchema = z.object({
  name: z.string().trim().min(1, '分组名称不能为空').max(100),
  description: z.string().trim().max(500).optional().or(z.literal('')),
})

export type ProductInput = z.infer<typeof productSchema>
export type ProductFinancialInput = z.infer<typeof productFinancialSchema>
export type ProductGroupInput = z.infer<typeof productGroupSchema>
