import { z } from 'zod'

export const businessOrderCommissionFilterSchema = z.object({
  q: z.string().trim().max(200).optional().default(''),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  shops: z.array(z.string().uuid()).optional().default([]),
  salespeople: z.array(z.string().uuid()).optional().default([]),
  shopGroups: z.array(z.string().uuid()).optional().default([]),
  page: z.coerce.number().int().min(1).optional().default(1),
})

export type BusinessOrderCommissionFilters = z.infer<typeof businessOrderCommissionFilterSchema>

const shippingCategories = ['stock', 'sample', 'custom', 'purchase'] as const

const percentRate = z
  .number({ invalid_type_error: '提点必须是数字' })
  .min(0, '提点不能为负')
  .max(100, '提点不能超过 100')
  .refine((value) => value === Math.round(value * 10000) / 10000, '提点最多保留 4 位小数')

const money = z
  .number({ invalid_type_error: '金额必须是数字' })
  .min(0, '金额不能为负')
  .max(999999999999, '金额超出允许范围')
  .refine((value) => value === Math.round(value * 10000) / 10000, '金额最多保留 4 位小数')

/** 产品明细行产品提点覆盖；rate 为 null 表示清除覆盖、回退到发货分类默认值。 */
export const businessOrderItemCommissionSchema = z.object({
  business_order_item_ids: z
    .array(z.string().uuid('订单明细行 ID 无效'))
    .min(1, '至少选择一条订单明细行'),
  rate: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? null : Number(value)),
    percentRate.nullable(),
  ),
})

/** 订单级运费成本与运费提点。 */
export const businessOrderCommissionSchema = z.object({
  business_order_id: z.string().uuid('订单 ID 无效'),
  freight_cost: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? 0 : Number(value)),
    money,
  ),
  freight_commission_rate: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? 0 : Number(value)),
    percentRate,
  ),
})

/** 按发货分类设置默认产品提点。 */
export const commissionCategoryRateSchema = z.object({
  category: z.enum(shippingCategories),
  product_commission_rate: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? 0 : Number(value)),
    percentRate,
  ),
})

export type BusinessOrderItemCommissionInput = z.infer<typeof businessOrderItemCommissionSchema>
export type BusinessOrderCommissionInput = z.infer<typeof businessOrderCommissionSchema>
export type CommissionCategoryRateInput = z.infer<typeof commissionCategoryRateSchema>
