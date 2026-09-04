'use server'

import { revalidatePath } from 'next/cache'
import { requireFinanceAccess } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import {
  dailyOrderBatchSchema,
  dailyOrderSchema,
  dailyOrderScreenshotSchema,
  dailyOrderShopSchema,
  type DailyOrderInput,
} from '@/schemas/daily-order'
import type { ActionResult } from './products'

export interface DailyOrderActionResult extends ActionResult {
  id?: string
  version?: number
}

function firstError(error: { issues: Array<{ message: string }> }) {
  return error.issues[0]?.message ?? '数据校验失败'
}

function mapError(message: string) {
  const errors: Array<[string, string]> = [
    ['Only approved admin or finance', '仅已审核的管理员或财务可操作每日订单'],
    ['Shop does not exist or is inactive', '店铺不存在或已停用'],
    ['Salesperson does not exist or is not approved', '业务员不存在或未审核'],
    ['Salesperson is not assigned to shop', '所选业务员未分配到该店铺'],
    ['Product does not exist or is inactive', '产品不存在或已停用'],
    ['Quantity cannot exceed 4 decimal places', '数量最多保留 4 位小数'],
    ['Amounts cannot exceed 2 decimal places', '金额最多保留 2 位小数'],
    ['Daily order version conflict', '记录已被他人修改，请刷新后重试'],
    ['Daily order cannot have more than 10', '每条订单最多上传 10 张截图'],
    ['Screenshot object does not exist', '截图尚未成功上传'],
    ['duplicate key value', '数据重复，请检查店铺名称或截图'],
  ]
  return errors.find(([source]) => message.includes(source))?.[1] ?? message
}

function rpcInput(input: DailyOrderInput) {
  return {
    p_order_date: input.order_date,
    p_shop_id: input.shop_id,
    p_salesperson_id: input.salesperson_id,
    p_order_number: input.order_number,
    p_shipping_date: input.shipping_date,
    p_shipping_number: input.shipping_number || null,
    p_shipping_category: input.shipping_category,
    p_product_id: input.product_id,
    p_quantity: input.quantity,
    p_sales_unit_price_amount: input.sales_unit_price_amount,
    p_sales_unit_price_currency: input.sales_unit_price_currency,
    p_product_received_amount: input.product_received_amount,
    p_product_received_currency: input.product_received_currency,
    p_logistics_fee_amount: input.logistics_fee_amount,
    p_logistics_fee_currency: input.logistics_fee_currency,
    p_sales_total_amount: input.sales_total_amount,
    p_sales_total_currency: input.sales_total_currency,
    p_payment_category: input.payment_category,
    p_remarks: input.remarks || null,
  }
}

function parseOrderResult(data: unknown) {
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
  return row && typeof row.id === 'string' && typeof row.version === 'number'
    ? { id: row.id, version: row.version }
    : null
}

function revalidateDailyOrders(id?: string) {
  revalidatePath('/finance/daily-orders')
  revalidatePath('/finance/daily-orders/settings')
  if (id) revalidatePath(`/finance/daily-orders/${id}/edit`)
}

export async function createDailyOrder(raw: unknown): Promise<DailyOrderActionResult> {
  await requireFinanceAccess()
  const parsed = dailyOrderSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('create_finance_daily_order', rpcInput(parsed.data))
  if (error) return { ok: false, error: mapError(error.message) }
  const result = parseOrderResult(data)
  if (!result) return { ok: false, error: '数据库未返回新记录' }
  revalidateDailyOrders(result.id)
  return { ok: true, ...result }
}

export async function updateDailyOrder(
  id: string,
  expectedVersion: number,
  raw: unknown,
): Promise<DailyOrderActionResult> {
  await requireFinanceAccess()
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return { ok: false, error: '版本无效' }
  const parsed = dailyOrderSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('update_finance_daily_order', {
    p_order_id: id,
    p_expected_version: expectedVersion,
    ...rpcInput(parsed.data),
  })
  if (error) return { ok: false, error: mapError(error.message) }
  const result = parseOrderResult(data)
  if (!result) return { ok: false, error: '数据库未返回更新结果' }
  revalidateDailyOrders(id)
  return { ok: true, ...result }
}

export async function bulkCreateDailyOrders(raw: unknown): Promise<ActionResult> {
  await requireFinanceAccess()
  const parsed = dailyOrderBatchSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: `第 ${parsed.error.issues[0]?.path[0] ?? '?'} 行：${firstError(parsed.error)}` }
  const supabase = await createClient()
  const { error } = await supabase.rpc('bulk_create_finance_daily_orders', { p_rows: parsed.data })
  if (error) return { ok: false, error: mapError(error.message) }
  revalidateDailyOrders()
  return { ok: true }
}

export async function voidDailyOrder(id: string, expectedVersion: number): Promise<ActionResult> {
  await requireFinanceAccess()
  const supabase = await createClient()
  const { error } = await supabase.rpc('void_finance_daily_order', {
    p_order_id: id,
    p_expected_version: expectedVersion,
  })
  if (error) return { ok: false, error: mapError(error.message) }
  revalidateDailyOrders(id)
  return { ok: true }
}

export async function saveDailyOrderShop(raw: unknown): Promise<ActionResult> {
  await requireFinanceAccess()
  const parsed = dailyOrderShopSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) }
  const supabase = await createClient()
  const { error } = await supabase.rpc('save_finance_daily_order_shop', {
    p_shop_id: parsed.data.id ?? null,
    p_name: parsed.data.name,
    p_is_active: parsed.data.is_active,
    p_salesperson_ids: parsed.data.salesperson_ids,
  })
  if (error) return { ok: false, error: mapError(error.message) }
  revalidateDailyOrders()
  return { ok: true }
}

export async function bindDailyOrderScreenshot(raw: unknown): Promise<ActionResult> {
  await requireFinanceAccess()
  const parsed = dailyOrderScreenshotSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: firstError(parsed.error) }
  const supabase = await createClient()
  const { error } = await supabase.rpc('bind_finance_daily_order_screenshot', {
    p_order_id: parsed.data.order_id,
    p_object_path: parsed.data.object_path,
    p_original_name: parsed.data.original_name,
    p_mime_type: parsed.data.mime_type,
    p_size_bytes: parsed.data.size_bytes,
  })
  if (error) return { ok: false, error: mapError(error.message) }
  revalidateDailyOrders(parsed.data.order_id)
  return { ok: true }
}

export async function removeDailyOrderScreenshot(id: string, orderId: string): Promise<ActionResult> {
  await requireFinanceAccess()
  const supabase = await createClient()
  const { error } = await supabase.rpc('remove_finance_daily_order_screenshot', { p_screenshot_id: id })
  if (error) return { ok: false, error: mapError(error.message) }
  revalidateDailyOrders(orderId)
  return { ok: true }
}

export async function getDailyOrderScreenshotUrl(id: string): Promise<{ url?: string; error?: string }> {
  await requireFinanceAccess()
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('finance_daily_order_screenshots')
    .select('object_path')
    .eq('id', id)
    .eq('status', 'active')
    .single()
  if (error || !data) return { error: '截图不存在或无权查看' }
  const { data: signed, error: signError } = await supabase.storage
    .from('finance-daily-order-screenshots')
    .createSignedUrl(data.object_path, 600)
  return signError ? { error: signError.message } : { url: signed.signedUrl }
}
