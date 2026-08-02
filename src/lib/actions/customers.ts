'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireProfile } from '@/lib/auth'
import { customerSchema } from '@/schemas/customer'
import type { ActionResult } from './products'

function parseCustomer(formData: FormData) {
  return customerSchema.safeParse({
    name: formData.get('name'),
    company: formData.get('company') || '',
    email: formData.get('email') || '',
    phone: formData.get('phone') || '',
    address: formData.get('address') || '',
    city: formData.get('city') || '',
    state: formData.get('state') || '',
    postal_code: formData.get('postal_code') || '',
    country: formData.get('country') || '',
    contact_person: formData.get('contact_person') || '',
    group_id: formData.get('group_id') || '',
  })
}

function normalize(data: ReturnType<typeof customerSchema.parse>) {
  return {
    name: data.name,
    company: data.company || null,
    email: data.email || null,
    phone: data.phone || null,
    address: data.address || null,
    city: data.city || null,
    state: data.state || null,
    postal_code: data.postal_code || null,
    country: data.country || null,
    contact_person: data.contact_person || null,
    group_id: data.group_id ? data.group_id : null,
  }
}

export async function createCustomer(
  formData: FormData,
): Promise<ActionResult & { id?: string }> {
  const profile = await requireProfile()
  const parsed = parseCustomer(formData)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('customers')
    .insert({ ...normalize(parsed.data), created_by: profile.id })
    .select('id')
    .single()
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers')
  return { ok: true, id: data.id }
}

export async function updateCustomer(id: string, formData: FormData): Promise<ActionResult & { id?: string }> {
  await requireProfile()
  const parsed = parseCustomer(formData)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('customers').update(normalize(parsed.data)).eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers')
  return { ok: true, id }
}

export async function deleteCustomer(id: string): Promise<ActionResult> {
  await requireProfile()
  const supabase = await createClient()
  // PIs keep customer_snapshot; FK is ON DELETE SET NULL so history survives.
  const { error } = await supabase.from('customers').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers')
  return { ok: true }
}

/**
 * 将客户转移到另一账号，并将该客户名下的 PI 一并转移。
 * RLS 限制：业务员只能转移自己的客户，管理员可转移任意客户。
 */
export async function transferCustomer(
  id: string,
  targetUserId: string,
): Promise<ActionResult> {
  await requireProfile()
  if (!targetUserId) return { ok: false, error: '请选择目标账号' }

  const supabase = await createClient()

  const { data: target } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', targetUserId)
    .single()
  if (!target) return { ok: false, error: '目标账号不存在' }

  const { error: custErr } = await supabase
    .from('customers')
    .update({ created_by: targetUserId })
    .eq('id', id)
  if (custErr) return { ok: false, error: custErr.message }

  // PI 归属一并转移
  const { error: piErr } = await supabase
    .from('proforma_invoices')
    .update({ created_by: targetUserId })
    .eq('customer_id', id)
  if (piErr) return { ok: false, error: piErr.message }

  revalidatePath('/customers')
  revalidatePath('/pi/history')
  return { ok: true }
}

/**
 * 将客户复制一份给另一账号（不复制 PI）。
 * RLS 限制：业务员只能复制自己可见的客户。
 */
export async function copyCustomer(
  id: string,
  targetUserId: string,
): Promise<ActionResult> {
  await requireProfile()
  if (!targetUserId) return { ok: false, error: '请选择目标账号' }

  const supabase = await createClient()

  const { data: target } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', targetUserId)
    .single()
  if (!target) return { ok: false, error: '目标账号不存在' }

  const { data: source, error: srcErr } = await supabase
    .from('customers')
    .select('name, company, email, phone, address, country, contact_person, group_id')
    .eq('id', id)
    .single()
  if (srcErr || !source) return { ok: false, error: srcErr?.message ?? '源客户不存在' }

  const { error: insErr } = await supabase.from('customers').insert({
    ...source,
    created_by: targetUserId,
  })
  if (insErr) return { ok: false, error: insErr.message }

  revalidatePath('/customers')
  return { ok: true }
}

/**
 * 批量转移客户到另一账号，并一并转移这些客户名下的 PI。
 */
export async function bulkTransferCustomers(
  ids: string[],
  targetUserId: string,
): Promise<ActionResult> {
  await requireProfile()
  if (!ids.length) return { ok: false, error: '未选择任何客户' }
  if (!targetUserId) return { ok: false, error: '请选择目标账号' }

  const supabase = await createClient()

  const { data: target } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', targetUserId)
    .single()
  if (!target) return { ok: false, error: '目标账号不存在' }

  const { error: custErr } = await supabase
    .from('customers')
    .update({ created_by: targetUserId })
    .in('id', ids)
  if (custErr) return { ok: false, error: custErr.message }

  const { error: piErr } = await supabase
    .from('proforma_invoices')
    .update({ created_by: targetUserId })
    .in('customer_id', ids)
  if (piErr) return { ok: false, error: piErr.message }

  revalidatePath('/customers')
  revalidatePath('/pi/history')
  return { ok: true }
}

/**
 * 批量复制客户给另一账号（不复制 PI）。
 */
export async function bulkCopyCustomers(
  ids: string[],
  targetUserId: string,
): Promise<ActionResult> {
  await requireProfile()
  if (!ids.length) return { ok: false, error: '未选择任何客户' }
  if (!targetUserId) return { ok: false, error: '请选择目标账号' }

  const supabase = await createClient()

  const { data: target } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', targetUserId)
    .single()
  if (!target) return { ok: false, error: '目标账号不存在' }

  const { data: sources, error: srcErr } = await supabase
    .from('customers')
    .select('name, company, email, phone, address, country, contact_person, group_id')
    .in('id', ids)
  if (srcErr) return { ok: false, error: srcErr.message }
  if (!sources?.length) return { ok: false, error: '没有可复制的客户' }

  const rows = sources.map((s) => ({ ...s, created_by: targetUserId }))
  const { error: insErr } = await supabase.from('customers').insert(rows)
  if (insErr) return { ok: false, error: insErr.message }

  revalidatePath('/customers')
  return { ok: true }
}

/**
 * 批量删除客户。已生成的 PI 保留客户快照（FK on delete set null）。
 */
export async function bulkDeleteCustomers(ids: string[]): Promise<ActionResult> {
  await requireProfile()
  if (!ids.length) return { ok: false, error: '未选择任何客户' }

  const supabase = await createClient()
  const { error } = await supabase.from('customers').delete().in('id', ids)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers')
  return { ok: true }
}

export interface BulkModifyPatch {
  country?: string
  company?: string
  contact_person?: string
  created_by?: string
}

/**
 * 批量修改选中客户的公共字段。仅更新填写了值的字段（留空即跳过）。
 * 归属账号（created_by）在此仅改客户归属，不搬动名下 PI —— 需连 PI 一并搬用 bulkTransferCustomers。
 */
export async function bulkModifyCustomers(
  ids: string[],
  patch: BulkModifyPatch,
): Promise<ActionResult> {
  await requireProfile()
  if (!ids.length) return { ok: false, error: '未选择任何客户' }

  const update: Record<string, string> = {}
  if (patch.country && patch.country.trim()) update.country = patch.country.trim()
  if (patch.company && patch.company.trim()) update.company = patch.company.trim()
  if (patch.contact_person && patch.contact_person.trim())
    update.contact_person = patch.contact_person.trim()
  if (patch.created_by) update.created_by = patch.created_by

  if (Object.keys(update).length === 0) {
    return { ok: false, error: '请至少填写一个要修改的字段' }
  }

  const supabase = await createClient()

  if (update.created_by) {
    const { data: target } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', update.created_by)
      .single()
    if (!target) return { ok: false, error: '目标账号不存在' }
  }

  const { error } = await supabase.from('customers').update(update).in('id', ids)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers')
  return { ok: true }
}

/**
 * 批量调整选中客户的分组。groupId 传 null 表示改为「未分组」。
 */
export async function bulkUpdateGroupCustomers(
  ids: string[],
  groupId: string | null,
): Promise<ActionResult> {
  await requireProfile()
  if (!ids.length) return { ok: false, error: '未选择任何客户' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('customers')
    .update({ group_id: groupId })
    .in('id', ids)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers')
  return { ok: true }
}
