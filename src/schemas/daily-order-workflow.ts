import { z } from 'zod'
import {
  dailyOrderCurrencies,
  dailyOrderPaymentCategories,
  dailyOrderShippingCategories,
} from './daily-order'

const version = z.coerce.number().int().min(1, '版本无效')

const date = z
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

const amount = z
  .union([z.number(), z.string().trim().min(1, '请输入金额')])
  .refine((value) => /^\d+(?:\.\d{1,2})?$/.test(String(value)), '金额最多保留 2 位小数')
  .pipe(z.coerce.number().min(0, '金额不能小于 0').max(999999999999, '金额超过上限'))

const quantity = z
  .union([z.number(), z.string().trim().min(1, '请输入数量')])
  .refine((value) => /^\d+(?:\.\d{1,4})?$/.test(String(value)), '数量最多保留 4 位小数')
  .pipe(z.coerce.number().positive('数量必须大于 0').max(999999999999))

const reason = z.string().trim().min(1, '请填写驳回原因').max(2000, '原因过长')

export const claimWorkflowSchema = z.object({
  workflowId: z.string().uuid('订单无效'),
  expectedVersion: version,
})

export const bindWorkflowCustomerSchema = z.object({
  workflowId: z.string().uuid('订单无效'),
  expectedVersion: version,
  customerId: z.string().uuid('请选择客户'),
})

export const submitPerformanceSchema = z.object({
  workflowId: z.string().uuid('订单无效'),
  expectedVersion: version,
})

export const reviewPerformanceSchema = z
  .object({
    workflowId: z.string().uuid('订单无效'),
    expectedVersion: version,
    approve: z.boolean(),
    reason: z.string().trim().max(2000, '原因过长').optional().default(''),
  })
  .refine((value) => value.approve || value.reason.length > 0, {
    message: '驳回时必须填写原因',
    path: ['reason'],
  })

export const saveCommissionSchema = z.object({
  workflowId: z.string().uuid('订单无效'),
  commissionAmount: amount,
  commissionCurrency: z.enum(dailyOrderCurrencies),
  remarks: z.string().trim().max(2000, '备注过长').optional().default(''),
})

// Whitelisted, mutable-by-sales order fields (mirrors the DB validate_daily_order_change_payload whitelist).
export const changeRequestPayloadSchema = z
  .object({
    shipping_date: date.optional(),
    shipping_number: z.string().trim().max(200, '物流单号过长').optional(),
    shipping_category: z.enum(dailyOrderShippingCategories).optional(),
    quantity: quantity.optional(),
    sales_unit_price_amount: amount.optional(),
    sales_unit_price_currency: z.enum(dailyOrderCurrencies).optional(),
    product_received_amount: amount.optional(),
    product_received_currency: z.enum(dailyOrderCurrencies).optional(),
    logistics_fee_amount: amount.optional(),
    logistics_fee_currency: z.enum(dailyOrderCurrencies).optional(),
    sales_total_amount: amount.optional(),
    sales_total_currency: z.enum(dailyOrderCurrencies).optional(),
    payment_category: z.enum(dailyOrderPaymentCategories).optional(),
    remarks: z.string().trim().max(2000, '备注过长').optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: '请至少修改一个字段',
  })

export const requestChangeSchema = z.object({
  orderId: z.string().uuid('订单行无效'),
  payload: changeRequestPayloadSchema,
})

export const reviewChangeSchema = z
  .object({
    changeId: z.string().uuid('申请无效'),
    approve: z.boolean(),
    reason: z.string().trim().max(2000, '原因过长').optional().default(''),
  })
  .refine((value) => value.approve || value.reason.length > 0, {
    message: '驳回时必须填写原因',
    path: ['reason'],
  })

export const cancelChangeSchema = z.object({
  changeId: z.string().uuid('申请无效'),
})

export type ClaimWorkflowInput = z.infer<typeof claimWorkflowSchema>
export type BindWorkflowCustomerInput = z.infer<typeof bindWorkflowCustomerSchema>
export type SubmitPerformanceInput = z.infer<typeof submitPerformanceSchema>
export type ReviewPerformanceInput = z.infer<typeof reviewPerformanceSchema>
export type SaveCommissionInput = z.infer<typeof saveCommissionSchema>
export type ChangeRequestPayload = z.infer<typeof changeRequestPayloadSchema>
export type RequestChangeInput = z.infer<typeof requestChangeSchema>
export type ReviewChangeInput = z.infer<typeof reviewChangeSchema>
export type CancelChangeInput = z.infer<typeof cancelChangeSchema>

// Reason field is only meaningful on rejection; exported for UI reuse.
export const rejectReasonSchema = reason
