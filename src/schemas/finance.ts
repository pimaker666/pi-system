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

export const businessOrderItemCostOverrideSchema = z.object({
  business_order_item_ids: z
    .array(z.string().uuid('订单明细行 ID 无效'))
    .min(1, '至少选择一条订单明细行'),
  cost: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? null : Number(value)),
    z.number({ invalid_type_error: '成本必须是数字' })
      .min(0, '成本不能为负')
      .max(999999999999, '成本超出允许范围')
      .refine((value) => value === Math.round(value * 10000) / 10000, '成本最多保留 4 位小数')
      .nullable(),
  ),
})

export const businessOrderItemSettlementSchema = z.object({
  business_order_item_ids: z
    .array(z.string().uuid('订单明细行 ID 无效'))
    .min(1, '至少选择一条订单明细行'),
  period: z.string().regex(/^\d{4}-\d{2}$/, '请选择结算年月'),
})

export const businessOrderItemUnsettleSchema = z.object({
  business_order_item_ids: z
    .array(z.string().uuid('订单明细行 ID 无效'))
    .min(1, '至少选择一条订单明细行'),
})

const scale4Refine = (value: number) => value === Math.round(value * 10000) / 10000

const booleanSelect = z.preprocess(
  (value) => value === 'true' || value === true,
  z.boolean(),
)

export const financeJournalEntrySchema = z.object({
  account_id: z.string().uuid('请选择银行账户'),
  category_id: z.string().uuid('请选择分类'),
  entry_date: dateSchema,
  kind: z.enum(['income', 'expense']),
  amount_original: z.coerce
    .number({ invalid_type_error: '金额必须是数字' })
    .positive('金额必须大于 0')
    .max(999999999999, '金额超出允许范围')
    .refine(scale4Refine, '金额最多保留 4 位小数'),
  currency: z.enum(financeCurrencies),
  exchange_rate_to_cny: z.coerce.number().positive('汇率必须大于 0').max(1000000),
  summary: z.string().trim().min(1, '请输入摘要').max(500),
  counterparty: z.string().trim().max(200).optional().default(''),
  reference_no: z.string().trim().max(200).optional().default(''),
  reimbursee: z.string().trim().max(200).optional().default(''),
  shop: z.string().trim().max(200).optional().default(''),
  remark: z.string().trim().max(1000).optional().default(''),
})

export const financeJournalAccountSchema = z.object({
  account_id: optionalUuid,
  name: z.string().trim().min(1, '请输入账户名称').max(100),
  currency: z.enum(financeCurrencies),
  initial_balance: z.coerce
    .number({ invalid_type_error: '期初余额必须是数字' })
    .min(-999999999999, '期初余额超出允许范围')
    .max(999999999999, '期初余额超出允许范围')
    .refine(scale4Refine, '期初余额最多保留 4 位小数'),
  is_active: booleanSelect,
})

export const financeJournalCategorySchema = z.object({
  category_id: optionalUuid,
  name: z.string().trim().min(1, '请输入分类名称').max(100),
  kind: z.enum(['income', 'expense']),
  sort_order: z.coerce.number().int('排序必须是整数').min(0).max(9999),
  is_active: booleanSelect,
})

export const financeJournalEntryVoidSchema = z.object({
  entry_id: z.string().uuid('分录 ID 无效'),
  void_reason: z.string().trim().min(1, '请填写作废原因').max(500),
})

// ---------------------------------------------------------------------------
// 费用报销（金额仅 CNY，不与记账联动）
// ---------------------------------------------------------------------------

const moneyField = (label: string) =>
  z.coerce
    .number({ invalid_type_error: `${label}必须是数字` })
    .positive(`${label}必须大于 0`)
    .max(999999999999, `${label}超出允许范围`)
    .refine(scale4Refine, `${label}最多保留 4 位小数`)

export const financeReimbursementItemSchema = z.object({
  summary: z.string().trim().min(1, '请输入摘要').max(500),
  unit_price: moneyField('单价'),
  quantity: moneyField('数量'),
  receipt_paths: z
    .array(
      z
        .string()
        .trim()
        .regex(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$/i,
          '凭证图片路径无效',
        ),
    )
    .max(9, '每行凭证最多 9 张')
    .default([]),
}).superRefine((item, ctx) => {
  if (item.unit_price * item.quantity >= 1e14) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['quantity'],
      message: '单价乘数量必须小于 100000000000000',
    })
  }
})

export const financeReimbursementRequestSchema = z.object({
  expense_date: dateSchema,
  project_name: z.string().trim().max(200).optional().default(''),
  items: z
    .array(financeReimbursementItemSchema)
    .min(1, '至少填写一条报销明细')
    .max(100, '报销明细最多 100 条'),
})

export const financeReimbursementReviewSchema = z.object({
  request_id: z.string().uuid('报销单 ID 无效'),
  decision: z.enum(['approve', 'reject']),
  reject_reason: z.string().trim().max(500).optional().default(''),
})

// 银行流水导入：客户端解析 CSV/粘贴文本得到原始行，服务端匹配规则与查重。
export const financeJournalImportRowSchema = z.object({
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式无效'),
  kind: z.enum(['income', 'expense']),
  amount_original: z.coerce
    .number({ invalid_type_error: '金额必须是数字' })
    .positive('金额必须大于 0')
    .max(999999999999, '金额超出允许范围')
    .refine(scale4Refine, '金额最多保留 4 位小数'),
  summary: z.string().trim().min(1, '摘要不能为空').max(500),
  counterparty: z.string().trim().max(200).optional().default(''),
  reference_no: z.string().trim().max(200).optional().default(''),
})

export const financeJournalImportPreviewSchema = z.object({
  account_id: z.string().uuid('请选择银行账户'),
  rows: z
    .array(financeJournalImportRowSchema)
    .min(1, '没有可导入的流水行')
    .max(2000, '单次最多导入 2000 行'),
})

export const financeJournalImportConfirmSchema = z.object({
  account_id: z.string().uuid('请选择银行账户'),
  exchange_rate_to_cny: z.coerce.number().positive('汇率必须大于 0').max(1000000),
  rows: z
    .array(
      financeJournalImportRowSchema.extend({
        category_id: z.string().uuid('请为每行选择分类'),
        reimbursee: z.string().trim().max(200).optional().default(''),
        shop: z.string().trim().max(200).optional().default(''),
      }),
    )
    .min(1, '没有可入账的流水行')
    .max(2000, '单次最多导入 2000 行'),
})

export const financeJournalImportRuleSchema = z
  .object({
    rule_id: optionalUuid,
    keyword: z.string().trim().min(1, '请输入关键词').max(100),
    category_id: optionalUuid,
    shop: z.string().trim().max(200).optional().default(''),
  })
  .refine((value) => value.category_id || value.shop, '请选择分类或填写店铺')

export type FinanceTransactionInput = z.infer<typeof financeTransactionSchema>
export type FinanceCostInput = z.infer<typeof financeCostSchema>
export type BusinessOrderItemCostOverrideInput = z.infer<typeof businessOrderItemCostOverrideSchema>
export type BusinessOrderItemSettlementInput = z.infer<typeof businessOrderItemSettlementSchema>
export type FinanceJournalImportRowInput = z.infer<typeof financeJournalImportRowSchema>
