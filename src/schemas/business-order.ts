import { z } from 'zod'
import { roundToScale } from '@/lib/utils'
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
export const businessOrderDailyShippingCategories = [
  'stock',
  'sample',
  'custom',
  'purchase',
] as const

const MAX_AMOUNT = 999999999999
const MAX_SAFE_QUANTITY = Math.floor(Number.MAX_SAFE_INTEGER / 10_000) / 10_000
const MAX_EXCHANGE_RATE = 1000000
const MAX_BATCH_SIZE = 500
const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const CUSTOMER_TRANSFER_PROOF_PATTERN = new RegExp(
  `^${UUID_PATTERN}/customer/${UUID_PATTERN}/${UUID_PATTERN}\\.(?:jpe?g|png|webp)$`,
  'i',
)
const BUSINESS_ORDER_ATTACHMENT_PATTERN = new RegExp(
  `^${UUID_PATTERN}/${UUID_PATTERN}/${UUID_PATTERN}\\.(?:jpe?g|png)$`,
  'i',
)

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '请选择有效日期')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number)
    const parsed = new Date(Date.UTC(year, month - 1, day))
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    )
  }, '请选择有效日期')
const optionalDateSchema = z.union([dateSchema, z.literal('')]).optional().default('')
const dateTimeSchema = z
  .string()
  .trim()
  .min(1, '请选择时间')
  .datetime({ offset: true, message: '请选择带时区的有效时间' })
const optionalText = (max: number, message: string) =>
  z.string().trim().max(max, message).optional().default('')

function decimalPlaces(value: number) {
  const [coefficient, exponentText = '0'] = value.toString().toLowerCase().split('e')
  const fractionLength = coefficient.split('.')[1]?.length ?? 0
  return Math.max(0, fractionLength - Number(exponentText))
}

function decimalNumber(scale: number, label: string, emptyAsZero = false) {
  const pattern = new RegExp(`^\\d+(?:\\.\\d{1,${scale}})?$`)
  return z
    .preprocess(
      (value) => (emptyAsZero && typeof value === 'string' && value.trim() === '' ? '0' : value),
      z.union([
        z.number().finite(`请输入有效${label}`),
        z.string().trim().min(1, `请输入${label}`).regex(pattern, `${label}最多保留 ${scale} 位小数`),
      ]),
    )
    .transform(Number)
    .refine((value) => decimalPlaces(value) <= scale, `${label}最多保留 ${scale} 位小数`)
}

const nonNegativeAmountSchema = decimalNumber(2, '金额', true).pipe(
  z.number().min(0, '金额不能为负').max(MAX_AMOUNT, '金额不能超过上限'),
)
const positiveAmountSchema = decimalNumber(2, '金额').pipe(
  z.number().positive('金额必须大于 0').max(MAX_AMOUNT, '金额不能超过上限'),
)
const positiveQuantitySchema = decimalNumber(4, '数量').pipe(
  z.number().positive('数量必须大于 0').max(MAX_SAFE_QUANTITY, '数量超过前端安全精度上限'),
)
const exchangeRateSchema = decimalNumber(8, '汇率').pipe(
  z.number().positive('汇率必须大于 0').max(MAX_EXCHANGE_RATE, '汇率不能超过 1000000'),
)

const dailyOrderItemFields = {
  daily_shipping_category: z.enum(businessOrderDailyShippingCategories),
  product_received_amount: nonNegativeAmountSchema,
  product_received_overridden: z.boolean(),
  logistics_fee_amount: nonNegativeAmountSchema,
  sales_total_amount: nonNegativeAmountSchema,
  sales_total_overridden: z.boolean(),
}

const catalogOrderItemSchema = z
  .object({
    order_item_id: z.string().uuid('订单明细 ID 不合法').optional(),
    source_type: z.literal('catalog'),
    product_id: z.string().uuid('请选择有效产品'),
    quantity: positiveQuantitySchema,
    unit_price: nonNegativeAmountSchema,
    ...dailyOrderItemFields,
  })
  .strict()

const customOrderItemSchema = z
  .object({
    order_item_id: z.string().uuid('订单明细 ID 不合法').optional(),
    source_type: z.literal('custom'),
    custom_product_id: z.string().uuid('请选择有效定制产品'),
    custom_product_version_id: z.string().uuid('请选择有效定制产品版本'),
    quantity: positiveQuantitySchema,
    unit_price: nonNegativeAmountSchema,
    ...dailyOrderItemFields,
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
    customer_id: z.string().uuid('请选择有效客户').nullable(),
    shop_id: z.string().uuid('请选择店铺'),
    salesperson_id: z.string().uuid('请选择业务员'),
    external_order_number: z.string().trim().min(1, '请输入订单号').max(200, '订单号不能超过 200 字'),
    order_date: dateSchema,
    payment_due_date: optionalDateSchema,
    fulfillment_type: z.enum(businessFulfillmentTypes),
    currency: z.enum(CURRENCIES),
    exchange_rate_to_cny: exchangeRateSchema,
    shipping_fee: nonNegativeAmountSchema,
    tracking_number: optionalText(200, '物流单号不能超过 200 字'),
    sales_notes: optionalText(2000, '业务备注不能超过 2000 字'),
    daily_shipping_date: dateSchema,
    daily_shipping_number: optionalText(200, '每日订单发货单号不能超过 200 字'),
    daily_payment_category: z.enum(businessPaymentTypes),
    total_product_received_amount: nonNegativeAmountSchema,
    total_product_received_overridden: z.boolean(),
    total_shipping_received_amount: nonNegativeAmountSchema,
    total_shipping_received_overridden: z.boolean(),
    total_sales_amount: nonNegativeAmountSchema,
    total_sales_overridden: z.boolean(),
    receivable_received_difference_reason: optionalText(1000, '应收实收差额原因不能超过 1000 字'),
    items: z
      .array(businessOrderItemInputSchema)
      .min(1, '请至少添加一条订单明细')
      .max(MAX_BATCH_SIZE, '订单明细不能超过 500 条'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seenItemIds = new Set<string>()
    value.items.forEach((item, index) => {
      if (item.order_item_id) {
        if (seenItemIds.has(item.order_item_id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['items', index, 'order_item_id'],
            message: '同一订单明细 ID 不能重复',
          })
        }
        seenItemIds.add(item.order_item_id)
      }

      const automaticProductReceived = roundToScale(item.quantity * item.unit_price, 2)
      if (!item.product_received_overridden && item.product_received_amount !== automaticProductReceived) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'product_received_amount'],
          message: '未手工覆盖时，产品实收金额必须等于单价乘数量',
        })
      }
      const automaticSalesTotal = roundToScale(
        item.product_received_amount + item.logistics_fee_amount,
        2,
      )
      if (!item.sales_total_overridden && item.sales_total_amount !== automaticSalesTotal) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'sales_total_amount'],
          message: '未手工覆盖时，明细实收合计必须等于产品实收加运费实收',
        })
      }
    })

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

    const productTotal = roundToScale(
      value.items.reduce((sum, item) => sum + item.product_received_amount, 0),
      2,
    )
    const shippingTotal = roundToScale(
      value.items.reduce((sum, item) => sum + item.logistics_fee_amount, 0),
      2,
    )
    const salesTotal = roundToScale(
      value.items.reduce((sum, item) => sum + item.sales_total_amount, 0),
      2,
    )
    if (!value.total_product_received_overridden && value.total_product_received_amount !== productTotal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['total_product_received_amount'],
        message: '未手工覆盖时，总产品实收必须等于明细合计',
      })
    }
    if (!value.total_shipping_received_overridden && value.total_shipping_received_amount !== shippingTotal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['total_shipping_received_amount'],
        message: '未手工覆盖时，总运费实收必须等于明细合计',
      })
    }
    if (!value.total_sales_overridden && value.total_sales_amount !== salesTotal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['total_sales_amount'],
        message: '未手工覆盖时，实际实收总额必须等于明细实收合计',
      })
    }
    if (
      Math.round(value.total_sales_amount * 100) !==
      Math.round(value.total_product_received_amount * 100) +
        Math.round(value.total_shipping_received_amount * 100)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['total_sales_amount'],
        message: '实际实收总额必须等于总产品实收加总运费实收',
      })
    }

    const receivableTotal = roundToScale(itemsSubtotal + value.shipping_fee, 2)
    if (
      Math.round(receivableTotal * 100) !== Math.round(value.total_sales_amount * 100) &&
      !value.receivable_received_difference_reason.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receivable_received_difference_reason'],
        message: '应收与实收存在差额时必须填写原因',
      })
    }
  })

export const businessOrderAttachmentInputSchema = z
  .object({
    order_id: z.string().uuid('请选择有效订单'),
    object_path: z
      .string()
      .trim()
      .max(500, '附件路径不能超过 500 字')
      .regex(BUSINESS_ORDER_ATTACHMENT_PATTERN, '附件路径格式不正确'),
    original_name: z.string().trim().max(255, '附件名称不能超过 255 字'),
    mime_type: z.enum(['image/jpeg', 'image/png']),
    size_bytes: z.number().int('附件大小无效').positive('附件不能为空').max(MAX_ATTACHMENT_SIZE, '附件不能超过 20MB'),
  })
  .strict()

export const businessCustomProductVersionInputSchema = z
  .object({
    product_group_id: z.string().uuid('请选择产品分组'),
    code: optionalText(100, '定制产品编码不能超过 100 字'),
    name: z.string().trim().min(1, '请填写定制产品名称').max(300, '定制产品名称不能超过 300 字'),
    description: optionalText(4000, '定制产品描述不能超过 4000 字'),
    specification: optionalText(2000, '定制产品规格不能超过 2000 字'),
    unit: optionalText(100, '单位不能超过 100 字'),
    image_url: optionalText(2000, '图片地址不能超过 2000 字'),
    quantity: positiveQuantitySchema,
    default_unit_price: nonNegativeAmountSchema,
    default_currency: z.enum(CURRENCIES),
    received_amount: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      nonNegativeAmountSchema.optional(),
    ),
  })
  .strict()

export const businessCustomProductInputSchema = z
  .object({
    initial_version: businessCustomProductVersionInputSchema.nullable().optional().default(null),
  })
  .strict()

export const businessCustomProductStateInputSchema = z
  .object({
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

export const businessOrderReturnItemInputSchema = z
  .object({
    shipment_item_id: z.string().uuid('请选择有效发货明细'),
    quantity: positiveQuantitySchema,
  })
  .strict()

const businessOrderReturnItemsSchema = z
  .array(businessOrderReturnItemInputSchema)
  .min(1, '请至少添加一条退货明细')
  .max(MAX_BATCH_SIZE, '退货明细不能超过 500 条')
  .superRefine((items, ctx) => {
    const seen = new Set<string>()
    items.forEach((item, index) => {
      if (seen.has(item.shipment_item_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'shipment_item_id'],
          message: '同一发货明细不能重复退货',
        })
      }
      seen.add(item.shipment_item_id)
    })
  })

export const businessOrderReturnInputSchema = z
  .object({
    returned_at: dateTimeSchema,
    notes: optionalText(1000, '退货备注不能超过 1000 字'),
    items: businessOrderReturnItemsSchema,
    idempotency_key: z.string().trim().min(1, '缺少幂等键').max(200, '幂等键不能超过 200 字'),
  })
  .strict()

export const businessOrderReturnVoidInputSchema = z
  .object({
    return_id: z.string().uuid('请选择有效退货记录'),
    reason: z.string().trim().min(1, '请填写作废原因').max(1000, '作废原因不能超过 1000 字'),
  })
  .strict()

export const businessOrderSpecialCloseInputSchema = z
  .object({
    order_id: z.string().uuid('请选择有效订单'),
    reason: z.string().trim().min(1, '请填写特殊关闭原因').max(1000, '关闭原因不能超过 1000 字'),
    expected_version: z.coerce.number().int('订单版本无效').positive('订单版本无效'),
  })
  .strict()

export const businessCustomProductLibraryFilterSchema = z
  .object({
    search: z.string().trim().max(200, '搜索内容不能超过 200 字').optional().default(''),
    product_group_id: z.string().uuid('请选择有效产品分组').optional(),
    status: z.enum(['active', 'archived', 'all']).optional().default('active'),
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
export type BusinessOrderAttachmentInput = z.infer<typeof businessOrderAttachmentInputSchema>
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
export type BusinessOrderReturnItemInput = z.infer<typeof businessOrderReturnItemInputSchema>
export type BusinessOrderReturnInput = z.infer<typeof businessOrderReturnInputSchema>
export type BusinessOrderReturnVoidInput = z.infer<typeof businessOrderReturnVoidInputSchema>
export type BusinessOrderSpecialCloseInput = z.infer<typeof businessOrderSpecialCloseInputSchema>
export type BusinessCustomProductLibraryFilter = z.infer<
  typeof businessCustomProductLibraryFilterSchema
>
export type BusinessOrderPaymentInput = z.infer<typeof businessOrderPaymentInputSchema>
export type BusinessOrderFinanceInput = z.infer<typeof businessOrderFinanceSchema>
