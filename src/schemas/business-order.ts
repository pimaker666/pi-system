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

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '请选择有效日期')
const optionalText = (max: number, message: string) =>
  z.string().trim().max(max, message).optional().default('')

export const businessOrderItemInputSchema = z.object({
  product_id: z.string().uuid('请选择有效产品'),
  quantity: z.coerce.number().positive('数量必须大于 0').max(999999999999),
  unit_price: z.coerce.number().min(0, '单价不能为负').max(999999999999),
})

export const businessOrderInputSchema = z
  .object({
    customer_id: z.string().uuid('请选择客户'),
    order_date: dateSchema,
    fulfillment_type: z.enum(businessFulfillmentTypes),
    currency: z.enum(CURRENCIES),
    exchange_rate_to_cny: z.coerce.number().positive('汇率必须大于 0').max(1000000),
    shipping_fee: z.coerce.number().min(0, '运费不能为负').max(999999999999),
    tracking_number: optionalText(200, '物流单号不能超过 200 字'),
    sales_notes: optionalText(2000, '业务备注不能超过 2000 字'),
    items: z
      .array(businessOrderItemInputSchema)
      .min(1, '请至少添加一条订单明细')
      .max(500, '订单明细不能超过 500 条'),
  })
  .superRefine((value, ctx) => {
    if (value.currency === 'CNY' && value.exchange_rate_to_cny !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exchange_rate_to_cny'],
        message: '人民币订单汇率必须为 1',
      })
    }
  })

export const businessOrderPaymentInputSchema = z.object({
  payment_type: z.enum(businessPaymentTypes),
  amount: z.coerce.number().positive('收款金额必须大于 0').max(999999999999),
  received_at: z
    .string()
    .trim()
    .min(1, '请选择收款时间')
    .refine((value) => !Number.isNaN(Date.parse(value)), '请选择有效收款时间'),
  proof_path: z
    .string()
    .trim()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpe?g|png|webp)$/i,
      '收款凭证路径格式不正确',
    ),
  notes: optionalText(1000, '收款备注不能超过 1000 字'),
  reason: optionalText(1000, '修正原因不能超过 1000 字'),
})

export const businessOrderReasonSchema = z.string().trim().max(1000, '说明不能超过 1000 字')

export const businessOrderFinanceSchema = z.object({
  wage_amount_cny: z.coerce.number().min(0, '工资/提成不能为负').max(999999999999),
  calculation_notes: z.string().trim().min(1, '请填写计算说明').max(4000, '计算说明不能超过 4000 字'),
  reason: optionalText(1000, '修正原因不能超过 1000 字'),
})

export type BusinessOrderInput = z.infer<typeof businessOrderInputSchema>
export type BusinessOrderItemInput = z.infer<typeof businessOrderItemInputSchema>
export type BusinessOrderPaymentInput = z.infer<typeof businessOrderPaymentInputSchema>
export type BusinessOrderFinanceInput = z.infer<typeof businessOrderFinanceSchema>
