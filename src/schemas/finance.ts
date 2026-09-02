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

export const financeOrderSchema = z.object({
  pi_id: z.string().uuid('请选择 PI'),
  exchange_rate_to_cny: z.coerce.number().positive('汇率必须大于 0').max(1000000),
  order_date: dateSchema,
  notes: z.string().trim().max(1000, '备注不能超过 1000 字').optional().default(''),
})

export const financeTransactionSchema = z.object({
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

export const financeCostSchema = z.object({
  finance_order_id: z.string().uuid('请选择订单'),
  cost_type: z.enum(financeCostTypes),
  incurred_date: dateSchema,
  amount_original: z.coerce.number().positive('金额必须大于 0').max(999999999999),
  currency: z.enum(financeCurrencies),
  exchange_rate_to_cny: z.coerce.number().positive('汇率必须大于 0').max(1000000),
  description: z.string().trim().max(1000).optional().default(''),
})

export type FinanceOrderInput = z.infer<typeof financeOrderSchema>
export type FinanceTransactionInput = z.infer<typeof financeTransactionSchema>
export type FinanceCostInput = z.infer<typeof financeCostSchema>
