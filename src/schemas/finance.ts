import { z } from 'zod'

export const financeCurrencies = ['USD', 'EUR', 'CNY', 'GBP', 'JPY'] as const
export const financeCostTypes = [
  'product',
  'shipping',
  'customs',
  'platform_fee',
  'payment_fee',
  'other',
] as const

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '请选择有效日期')
const optionalUuid = z.preprocess(
  (value) => (value === '' || value == null ? undefined : value),
  z.string().uuid().optional(),
)

const duplicateReceiptCategories = new Set([
  '客户回款',
  '客户收款',
  '订单回款',
  'customerpayment',
  'customerpaymentreceipt',
  'orderpayment',
])

export const financeTransactionSchema = z
  .object({
    transaction_type: z.enum(['income', 'expense']),
    category: z.string().trim().min(1, '请输入分类').max(100),
    transaction_date: dateSchema,
    amount_original: z.coerce.number().positive('金额必须大于 0').max(999999999999),
    currency: z.enum(financeCurrencies),
    exchange_rate_to_cny: z.coerce.number().positive('汇率必须大于 0').max(1000000),
    finance_order_id: optionalUuid,
    salesperson_id: optionalUuid,
    reference_no: z.string().trim().max(100).optional().default(''),
    description: z.string().trim().max(1000).optional().default(''),
  })
  .superRefine((value, ctx) => {
    const normalizedCategory = value.category.toLocaleLowerCase().replace(/\s+/g, '')
    if (value.transaction_type === 'income' && duplicateReceiptCategories.has(normalizedCategory)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['category'],
        message: '业务订单客户收款请在订单详情中登记，不能重复录入流水',
      })
    }
  })

export const financeCostSchema = z.object({
  order_reference: z.string().regex(
    /^(finance|business):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    '请选择订单',
  ),
  cost_type: z.enum(financeCostTypes),
  incurred_date: dateSchema,
  amount_original: z.coerce.number().positive('金额必须大于 0').max(999999999999),
  currency: z.enum(financeCurrencies),
  exchange_rate_to_cny: z.coerce.number().positive('汇率必须大于 0').max(1000000),
  description: z.string().trim().max(1000).optional().default(''),
})

export const dailyOrderCostOverrideSchema = z.object({
  daily_order_id: z.string().uuid('订单行 ID 无效'),
  cost: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? null : Number(value)),
    z.number({ invalid_type_error: '成本必须是数字' })
      .min(0, '成本不能为负')
      .max(999999999999, '成本超出允许范围')
      .refine((value) => value === Math.round(value * 10000) / 10000, '成本最多保留 4 位小数')
      .nullable(),
  ),
})

export type FinanceTransactionInput = z.infer<typeof financeTransactionSchema>
export type FinanceCostInput = z.infer<typeof financeCostSchema>
