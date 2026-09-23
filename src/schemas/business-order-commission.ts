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
  settlement_exchange_rate_to_cny: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? null : Number(value)),
    z.number().positive('汇率必须大于 0').max(1000, '汇率超出允许范围').nullable(),
  ),
})

export const businessOrderFreightCommissionRateSchema = z.object({
  business_order_ids: z.array(z.string().uuid('订单 ID 无效')).min(1, '至少选择一个订单'),
  freight_commission_rate: percentRate,
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

/** 按客户累计定制订单数设置产品提点上限。 */
export const customerCustomOrderCommissionRateSchema = z.object({
  maximum_custom_order_count: z.coerce
    .number()
    .int('定制单数必须是整数')
    .min(0, '定制单数不能为负')
    .max(1000000, '定制单数超出允许范围'),
  product_commission_rate: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? 0 : Number(value)),
    percentRate,
  ),
})

export const customerCustomOrderCommissionRatesSchema = z
  .array(customerCustomOrderCommissionRateSchema)
  .max(50, '规则数量不能超过 50 个')
  .superRefine((rates, ctx) => {
    const seen = new Set<number>()
    rates.forEach((rate, index) => {
      if (seen.has(rate.maximum_custom_order_count)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '同一定制单数只能设置一条规则',
          path: [index, 'maximum_custom_order_count'],
        })
      }
      seen.add(rate.maximum_custom_order_count)
    })
  })

export type CustomerCustomOrderCommissionRateInput = z.infer<
  typeof customerCustomOrderCommissionRateSchema
>

/** 提成结清提交：财务选择一组产品行并指定归属年月。 */
export const businessOrderCommissionClearanceSubmitSchema = z.object({
  business_order_item_ids: z
    .array(z.string().uuid('订单明细行 ID 无效'))
    .min(1, '至少选择一条订单明细行'),
  period: z.string().regex(/^\d{4}-\d{2}$/, '请选择有效年月'),
})

/** 业务员确认结清。 */
export const businessOrderCommissionClearanceConfirmSchema = z.object({
  business_order_item_ids: z
    .array(z.string().uuid('订单明细行 ID 无效'))
    .min(1, '至少选择一条订单明细行'),
})

/** 业务员驳回结清。 */
export const businessOrderCommissionClearanceRejectSchema = z.object({
  business_order_item_ids: z
    .array(z.string().uuid('订单明细行 ID 无效'))
    .min(1, '至少选择一条订单明细行'),
  reason: z.string().trim().min(1, '请填写驳回原因').max(500, '驳回原因不能超过 500 字'),
})

export type BusinessOrderCommissionClearanceSubmitInput = z.infer<
  typeof businessOrderCommissionClearanceSubmitSchema
>
export type BusinessOrderCommissionClearanceConfirmInput = z.infer<
  typeof businessOrderCommissionClearanceConfirmSchema
>
export type BusinessOrderCommissionClearanceRejectInput = z.infer<
  typeof businessOrderCommissionClearanceRejectSchema
>

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, '颜色格式错误（应为 #RRGGBB）')

/** 客户标记提点定义：颜色 + 含义 + 产品提点（百分数）。 */
export const customerCommissionTagSchema = z.object({
  tag_color: hexColor,
  label: z.string().trim().min(1, '请填写标记含义').max(50, '标记含义不能超过 50 字'),
  product_commission_rate: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? 0 : Number(value)),
    percentRate,
  ),
  sort_order: z.coerce.number().int().min(0).max(9999).optional().default(0),
})

export const customerCommissionTagsSchema = z
  .array(customerCommissionTagSchema)
  .max(50, '标记数量不能超过 50 个')
  .superRefine((tags, ctx) => {
    const seen = new Set<string>()
    tags.forEach((tag, index) => {
      const key = tag.tag_color.toLowerCase()
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '同一颜色只能有一个标记',
          path: [index, 'tag_color'],
        })
      }
      seen.add(key)
    })
  })

export type CustomerCommissionTagInput = z.infer<typeof customerCommissionTagSchema>
