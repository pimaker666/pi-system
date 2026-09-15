'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireProfile } from '@/lib/auth'
import { customerSchema } from '@/schemas/customer'
import type { Customer } from '@/types'
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
): Promise<ActionResult & { id?: string; customer?: Customer }> {
  const profile = await requireProfile()
  const parsed = parseCustomer(formData)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('customers')
    .insert({ ...normalize(parsed.data), created_by: profile.id })
    .select('*')
    .single()
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers')
  return { ok: true, id: data.id, customer: data }
}

export async function updateCustomer(
  id: string,
  formData: FormData,
): Promise<ActionResult & { id?: string; customer?: Customer }> {
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
 * 转移客户的当前负责人。历史 PI 创建人和姓名快照保持不变；
 * 新负责人通过客户归属继续访问该客户的历史资料。
 */
export async function transferCustomer(
  id: string,
  targetUserId: string,
): Promise<ActionResult> {
  await requireProfile()
  if (!targetUserId) return { ok: false, error: '请选择目标账号' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('transfer_customers', {
    p_customer_ids: [id],
    p_target_user_id: targetUserId,
    p_country: null,
    p_company: null,
    p_contact_person: null,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers')
  revalidatePath('/pi/history')
  return { ok: true }
}

/**
 * 将客户复制一份给另一账号（不复制 PI）。
 * 数据库 RPC 会原子校验全部源客户的存在性、所有权和目标账号状态。
 */
export async function copyCustomer(
  id: string,
  targetUserId: string,
): Promise<ActionResult> {
  await requireProfile()
  if (!targetUserId) return { ok: false, error: '请选择目标账号' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('copy_customers', {
    p_customer_ids: [id],
    p_target_user_id: targetUserId,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers')
  return { ok: true }
}

/** 批量转移客户的当前负责人；历史 PI 创建人和姓名快照保持不变。 */
export async function bulkTransferCustomers(
  ids: string[],
  targetUserId: string,
): Promise<ActionResult> {
  await requireProfile()
  if (!ids.length) return { ok: false, error: '未选择任何客户' }
  if (!targetUserId) return { ok: false, error: '请选择目标账号' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('transfer_customers', {
    p_customer_ids: ids,
    p_target_user_id: targetUserId,
    p_country: null,
    p_company: null,
    p_contact_person: null,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers')
  revalidatePath('/pi/history')
  return { ok: true }
}

/** 批量复制客户给另一账号（不复制 PI）。 */
export async function bulkCopyCustomers(
  ids: string[],
  targetUserId: string,
): Promise<ActionResult> {
  await requireProfile()
  if (!ids.length) return { ok: false, error: '未选择任何客户' }
  if (!targetUserId) return { ok: false, error: '请选择目标账号' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('copy_customers', {
    p_customer_ids: ids,
    p_target_user_id: targetUserId,
  })
  if (error) return { ok: false, error: error.message }

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
 * 归属账号（created_by）只表示客户当前负责人，历史 PI 创建人始终保持不变。
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

  if (Object.keys(update).length === 0 && !patch.created_by) {
    return { ok: false, error: '请至少填写一个要修改的字段' }
  }

  const supabase = await createClient()

  if (patch.created_by) {
    const { error } = await supabase.rpc('transfer_customers', {
      p_customer_ids: ids,
      p_target_user_id: patch.created_by,
      p_country: update.country ?? null,
      p_company: update.company ?? null,
      p_contact_person: update.contact_person ?? null,
    })
    if (error) return { ok: false, error: error.message }
  } else {
    const { error } = await supabase.from('customers').update(update).in('id', ids)
    if (error) return { ok: false, error: error.message }
  }

  revalidatePath('/customers')
  if (patch.created_by) revalidatePath('/pi/history')
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
