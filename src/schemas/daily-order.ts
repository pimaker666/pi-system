import { z } from 'zod'

export const dailyOrderCurrencies = ['CNY', 'USD'] as const
export const dailyOrderShippingCategories = ['stock', 'sample', 'custom', 'purchase'] as const
export const dailyOrderPaymentCategories = ['full', 'deposit', 'balance'] as const

const date = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '请选择有效日期')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number)
    const parsed = new Date(Date.UTC(year, month - 1, day))
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
  }, '请选择有效日期')
const amount = z.union([
  z.number(),
  z.string().trim().min(1, '请输入金额'),
])
  .refine((value) => /^\d+(?:\.\d{1,2})?$/.test(String(value)), '金额最多保留 2 位小数')
  .pipe(z.coerce.number().min(0, '金额不能小于 0').max(999999999999, '金额超过上限'))
const quantity = z.union([
  z.number(),
  z.string().trim().min(1, '请输入数量'),
])
  .refine((value) => /^\d+(?:\.\d{1,4})?$/.test(String(value)), '数量最多保留 4 位小数')
  .pipe(z.coerce.number().positive('数量必须大于 0').max(999999999999))

export const dailyOrderSchema = z.object({
  order_date: date,
  shop_id: z.string().uuid('请选择店铺'),
  salesperson_id: z.string().uuid('请选择业务员'),
  order_number: z.string().trim().min(1, '请输入订单号').max(200),
  shipping_date: date,
  shipping_number: z.string().trim().max(200).optional().default(''),
  shipping_category: z.enum(dailyOrderShippingCategories),
  product_id: z.string().uuid('请选择产品'),
  quantity,
  sales_unit_price_amount: amount,
  sales_unit_price_currency: z.enum(dailyOrderCurrencies),
  product_received_amount: amount,
  product_received_currency: z.enum(dailyOrderCurrencies),
  logistics_fee_amount: amount,
  logistics_fee_currency: z.enum(dailyOrderCurrencies),
  sales_total_amount: amount,
  sales_total_currency: z.enum(dailyOrderCurrencies),
  payment_category: z.enum(dailyOrderPaymentCategories),
  remarks: z.string().trim().max(2000).optional().default(''),
})

export const dailyOrderFilterSchema = z.object({
  q: z.string().trim().max(200).optional().default(''),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  shop: z.string().uuid().optional(),
  salesperson: z.string().uuid().optional(),
  category: z.enum(dailyOrderShippingCategories).optional(),
  payment: z.enum(dailyOrderPaymentCategories).optional(),
})

export const dailyOrderShopSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, '请输入店铺名称').max(100),
  group_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean(),
  salesperson_ids: z.array(z.string().uuid()).max(200),
})

export const dailyOrderShopGroupSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, '请输入分组名称').max(100),
})

export const dailyOrderScreenshotSchema = z.object({
  order_id: z.string().uuid(),
  object_path: z.string().min(1).max(500),
  original_name: z.string().max(255),
  mime_type: z.enum(['image/jpeg', 'image/png']),
  size_bytes: z.number().int().positive().max(5 * 1024 * 1024),
})

export const dailyOrderBatchSchema = z.array(dailyOrderSchema).min(1).max(500)

export type DailyOrderInput = z.infer<typeof dailyOrderSchema>
export type DailyOrderFilters = z.infer<typeof dailyOrderFilterSchema>
