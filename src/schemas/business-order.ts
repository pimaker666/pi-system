import { z } from 'zod'
import { CURRENCIES } from './product'

export const businessOrderStatuses = [
  'draft',
  'submitted',
  'rejected',
  'approved',
  'completed',
] as const
export const businessFulfillmentTypes = ['custom', 'stock'] as const
export const businessPaymentTypes = ['full', 'deposit', 'balance'] as const
export const businessOrderItemSourceTypes = ['catalog', 'custom', 'legacy'] as const

const MAX_AMOUNT = 999999999999
const MAX_SAFE_QUANTITY = Math.floor(Number.MAX_SAFE_INTEGER / 10_000) / 10_000
const MAX_EXCHANGE_RATE = 1000000
const MAX_BATCH_SIZE = 500
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const CUSTOMER_TRANSFER_PROOF_PATTERN = new RegExp(
  `^${UUID_PATTERN}/customer/${UUID_PATTERN}/${UUID_PATTERN}\\.(?:jpe?g|png|webp)$`,
  'i',
)

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '请选择有效日期')
const optionalDateSchema = z.union([dateSchema, z.literal('')]).optional().default('')
const dateTimeSchema = z
  .string()
  .trim()
  .min(1, '请选择时间')
  .datetime({ offset: true, message: '请选择带时区的有效时间' })
const optionalText = (max: number, message: string) =>
  z.string().trim().max(max, message).optional().default('')

function roundToScale(value: number, scale: number) {
  const [coefficient, exponent = '0'] = value.toString().split('e')
  const shifted = Number(`${coefficient}e${Number(exponent) + scale}`)
  return Number(`${Math.round(shifted)}e-${scale}`)
}

function roundedNumber(scale: number) {
  return z.coerce
    .number()
    .finite('请输入有效数字')
    .transform((value) => roundToScale(value, scale))
}

const nonNegativeAmountSchema = z.coerce
  .number()
  .finite('请输入有效数字')
  .min(0, '金额不能为负')
  .max(MAX_AMOUNT, '金额不能超过上限')
  .transform((value) => roundToScale(value, 2))
const positiveAmountSchema = roundedNumber(2).pipe(
  z.number().positive('金额必须大于 0').max(MAX_AMOUNT, '金额不能超过上限'),
)
const positiveQuantitySchema = roundedNumber(4).pipe(
  z.number().positive('数量必须大于 0').max(MAX_SAFE_QUANTITY, '数量超过前端安全精度上限'),
)
const exchangeRateSchema = roundedNumber(8).pipe(
  z.number().positive('汇率必须大于 0').max(MAX_EXCHANGE_RATE, '汇率不能超过 1000000'),
)

const catalogOrderItemSchema = z
  .object({
    source_type: z.literal('catalog'),
    product_id: z.string().uuid('请选择有效产品'),
    quantity: positiveQuantitySchema,
    unit_price: nonNegativeAmountSchema,
  })
  .strict()

const customOrderItemSchema = z
  .object({
    source_type: z.literal('custom'),
    custom_product_id: z.string().uuid('请选择有效定制产品'),
    custom_product_version_id: z.string().uuid('请选择有效定制产品版本'),
    quantity: positiveQuantitySchema,
    unit_price: nonNegativeAmountSchema,
  })
  .strict()

const businessOrderItemDiscriminatedSchema = z.discriminatedUnion('source_type', [
  catalogOrderItemSchema,
  customOrderItemSchema,
])

export const businessOrderItemInputSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'source_type' in value) {
    return value
  }
  return { ...value, source_type: 'catalog' }
}, businessOrderItemDiscriminatedSchema)

export const businessOrderInputSchema = z
  .object({
    customer_id: z.string().uuid('请选择客户'),
    order_date: dateSchema,
    payment_due_date: optionalDateSchema,
    fulfillment_type: z.enum(businessFulfillmentTypes),
    currency: z.enum(CURRENCIES),
    exchange_rate_to_cny: exchangeRateSchema,
    shipping_fee: nonNegativeAmountSchema,
    tracking_number: optionalText(200, '物流单号不能超过 200 字'),
    sales_notes: optionalText(2000, '业务备注不能超过 2000 字'),
    items: z
      .array(businessOrderItemInputSchema)
      .min(1, '请至少添加一条订单明细')
      .max(MAX_BATCH_SIZE, '订单明细不能超过 500 条'),
  })
  .superRefine((value, ctx) => {
    if (value.currency === 'CNY' && value.exchange_rate_to_cny !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exchange_rate_to_cny'],
        message: '人民币订单汇率必须为 1',
      })
    }
    if (value.payment_due_date && value.payment_due_date < value.order_date) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payment_due_date'],
        message: '尾款到期日不能早于订单日期',
      })
    }
    const itemsSubtotal = value.items.reduce(
      (sum, item) => sum + roundToScale(item.quantity * item.unit_price, 2),
      0,
    )
    if (itemsSubtotal > MAX_AMOUNT || itemsSubtotal + value.shipping_fee > MAX_AMOUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: '订单汇总金额不能超过上限',
      })
    }
  })

export const businessCustomProductVersionInputSchema = z
  .object({
    code: z.string().trim().min(1, '请填写定制产品编码').max(100, '定制产品编码不能超过 100 字'),
    name: z.string().trim().min(1, '请填写定制产品名称').max(300, '定制产品名称不能超过 300 字'),
    description: optionalText(4000, '定制产品描述不能超过 4000 字'),
    specification: optionalText(2000, '定制产品规格不能超过 2000 字'),
    unit: z.string().trim().min(1, '请填写单位').max(100, '单位不能超过 100 字'),
    image_url: optionalText(2000, '图片地址不能超过 2000 字'),
    default_unit_price: nonNegativeAmountSchema,
    default_currency: z.enum(CURRENCIES),
  })
  .strict()

export const businessCustomProductInputSchema = z
  .object({
    customer_id: z.string().uuid('请选择客户'),
    is_shared: z.boolean().optional().default(false),
    initial_version: businessCustomProductVersionInputSchema.nullable().optional().default(null),
  })
  .strict()

export const businessCustomProductStateInputSchema = z
  .object({
    is_shared: z.boolean(),
    is_archived: z.boolean(),
    reason: optionalText(1000, '原因不能超过 1000 字'),
  })
  .strict()

export const businessOrderPaymentAllocationInputSchema = z
  .object({
    order_id: z.string().uuid('请选择有效订单'),
    amount: positiveAmountSchema,
    payment_type: z.enum(businessPaymentTypes).optional(),
  })
  .strict()

const businessOrderPaymentAllocationsSchema = z
  .array(businessOrderPaymentAllocationInputSchema)
  .max(MAX_BATCH_SIZE, '分摊不能超过 500 条')
  .superRefine((allocations, ctx) => {
    const seen = new Set<string>()
    allocations.forEach((allocation, index) => {
      if (seen.has(allocation.order_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'order_id'],
          message: '同一订单不能重复分摊',
        })
      }
      seen.add(allocation.order_id)
    })
  })

const businessCustomerTransferBaseSchema = z.object({
  customer_id: z.string().uuid('请选择客户'),
  currency: z.enum(CURRENCIES),
  amount: positiveAmountSchema,
  exchange_rate_to_cny: exchangeRateSchema,
  received_at: dateTimeSchema,
  payment_type: z.enum(businessPaymentTypes),
  proof_path: z
    .string()
    .trim()
    .regex(CUSTOMER_TRANSFER_PROOF_PATTERN, '收款凭证必须使用 uid/customer/customerId/file 路径'),
  notes: optionalText(1000, '收款备注不能超过 1000 字'),
  idempotency_key: z.string().trim().min(1, '缺少幂等键').max(200, '幂等键不能超过 200 字'),
})

function validateCustomerTransfer(
  value: {
    customer_id: string
    currency: (typeof CURRENCIES)[number]
    exchange_rate_to_cny: number
    proof_path: string
  },
  ctx: z.RefinementCtx,
) {
  if (value.currency === 'CNY' && value.exchange_rate_to_cny !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['exchange_rate_to_cny'],
      message: '人民币转账汇率必须为 1',
    })
  }
  if (value.proof_path.split('/')[2]?.toLowerCase() !== value.customer_id.toLowerCase()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['proof_path'],
      message: '收款凭证路径中的客户与转账客户不一致',
    })
  }
}

export const businessCustomerTransferInputSchema = businessCustomerTransferBaseSchema
  .extend({
    allocations: businessOrderPaymentAllocationsSchema.optional().default([]),
    correction_reason: optionalText(1000, '修正原因不能超过 1000 字'),
  })
  .strict()
  .superRefine(validateCustomerTransfer)

export const businessCustomerTransferAllocationInputSchema = z
  .object({
    allocations: businessOrderPaymentAllocationsSchema.refine(
      (allocations) => allocations.length > 0,
      '请至少添加一条分摊',
    ),
    correction_reason: optionalText(1000, '修正原因不能超过 1000 字'),
    idempotency_key: z.string().trim().min(1, '缺少幂等键').max(200, '幂等键不能超过 200 字'),
  })
  .strict()

export const businessOrderShipmentItemInputSchema = z
  .object({
    order_item_id: z.string().uuid('请选择有效订单明细'),
    quantity: positiveQuantitySchema,
  })
  .strict()

const businessOrderShipmentItemsSchema = z
  .array(businessOrderShipmentItemInputSchema)
  .min(1, '请至少添加一条发货明细')
  .max(MAX_BATCH_SIZE, '发货明细不能超过 500 条')
  .superRefine((items, ctx) => {
    const seen = new Set<string>()
    items.forEach((item, index) => {
      if (seen.has(item.order_item_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'order_item_id'],
          message: '同一订单明细不能重复发货',
        })
      }
      seen.add(item.order_item_id)
    })
  })

export const businessOrderShipmentInputSchema = z
  .object({
    shipped_at: dateTimeSchema,
    tracking_number: optionalText(200, '物流单号不能超过 200 字'),
    notes: optionalText(1000, '发货备注不能超过 1000 字'),
    items: businessOrderShipmentItemsSchema,
    idempotency_key: z.string().trim().min(1, '缺少幂等键').max(200, '幂等键不能超过 200 字'),
  })
  .strict()

export const businessOrderVoidReasonSchema = z
  .string()
  .trim()
  .min(1, '请填写作废原因')
  .max(1000, '作废原因不能超过 1000 字')

/** Legacy component input; writes are adapted to a customer transfer plus one allocation. */
export const businessOrderPaymentInputSchema = businessCustomerTransferBaseSchema
  .extend({
    reason: optionalText(1000, '修正原因不能超过 1000 字'),
  })
  .strict()
  .superRefine(validateCustomerTransfer)

export const businessOrderReasonSchema = z.string().trim().max(1000, '说明不能超过 1000 字')

export const businessOrderFinanceSchema = z.object({
  wage_amount_cny: nonNegativeAmountSchema,
  calculation_notes: z.string().trim().min(1, '请填写计算说明').max(4000, '计算说明不能超过 4000 字'),
  reason: optionalText(1000, '修正原因不能超过 1000 字'),
})

export type BusinessOrderInput = z.infer<typeof businessOrderInputSchema>
export type BusinessOrderItemInput = z.infer<typeof businessOrderItemInputSchema>
export type BusinessCustomProductVersionInput = z.infer<
  typeof businessCustomProductVersionInputSchema
>
export type BusinessCustomProductInput = z.infer<typeof businessCustomProductInputSchema>
export type BusinessCustomProductStateInput = z.infer<typeof businessCustomProductStateInputSchema>
export type BusinessOrderPaymentAllocationInput = z.infer<
  typeof businessOrderPaymentAllocationInputSchema
>
export type BusinessCustomerTransferInput = z.infer<typeof businessCustomerTransferInputSchema>
export type BusinessCustomerTransferAllocationInput = z.infer<
  typeof businessCustomerTransferAllocationInputSchema
>
export type BusinessOrderShipmentItemInput = z.infer<typeof businessOrderShipmentItemInputSchema>
export type BusinessOrderShipmentInput = z.infer<typeof businessOrderShipmentInputSchema>
export type BusinessOrderPaymentInput = z.infer<typeof businessOrderPaymentInputSchema>
export type BusinessOrderFinanceInput = z.infer<typeof businessOrderFinanceSchema>
