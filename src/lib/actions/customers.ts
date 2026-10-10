'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin, requireProfile } from '@/lib/auth'
import { formatCountryName } from '@/lib/country-flags'
import { customerSchema, newCustomerSchema } from '@/schemas/customer'
import type { Customer } from '@/types'
import type { ActionResult } from './products'

function parseLogoUrls(value: FormDataEntryValue | null): unknown {
  if (typeof value !== 'string') return []
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function customerFormValues(formData: FormData) {
  return {
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
    brand_name: formData.get('brand_name') || '',
    logo_urls: parseLogoUrls(formData.get('logo_urls')),
    remarks: formData.get('remarks') || '',
    group_id: formData.get('group_id') || '',
  }
}

function parseCustomer(formData: FormData) {
  return customerSchema.safeParse(customerFormValues(formData))
}

function parseNewCustomer(formData: FormData) {
  return newCustomerSchema.safeParse(customerFormValues(formData))
}

const CUSTOMER_ASSET_PREFIX = '/storage/v1/object/public/customer-assets/'

function customerLogoObjectPath(url: string) {
  const index = url.indexOf(CUSTOMER_ASSET_PREFIX)
  if (index < 0) return null
  try {
    return url
      .slice(index + CUSTOMER_ASSET_PREFIX.length)
      .split(/[?#]/, 1)[0]
      .split('/')
      .map(decodeURIComponent)
      .join('/')
  } catch {
    return null
  }
}

function normalizeCountry(country: string) {
  const value = country.trim()
  return value ? formatCountryName(value) : null
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
    country: normalizeCountry(data.country ?? ''),
    contact_person: data.contact_person || null,
    brand_name: data.brand_name || null,
    logo_urls: data.logo_urls,
    logo_url: data.logo_urls[0] ?? null,
    remarks: data.remarks || null,
    group_id: data.group_id ? data.group_id : null,
  }
}

export async function createCustomer(
  formData: FormData,
): Promise<ActionResult & { id?: string; customer?: Customer }> {
  const profile = await requireProfile()
  const parsed = parseNewCustomer(formData)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }
  if (parsed.data.logo_urls.some((url) => !customerLogoObjectPath(url))) {
    return { ok: false, error: 'Logo 必须通过客户资料上传' }
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
  if (parsed.data.logo_urls.some((url) => !customerLogoObjectPath(url))) {
    return { ok: false, error: 'Logo 必须通过客户资料上传' }
  }

  const supabase = await createClient()
  const { data: current, error: currentError } = await supabase
    .from('customers')
    .select('logo_urls, logo_url')
    .eq('id', id)
    .single()
  if (currentError) return { ok: false, error: currentError.message }

  const { error } = await supabase.from('customers').update(normalize(parsed.data)).eq('id', id)
  if (error) return { ok: false, error: error.message }

  const currentLogoUrls = current as { logo_urls: string[] | null; logo_url: string | null }
  const previousUrls: string[] = currentLogoUrls.logo_urls?.length
    ? currentLogoUrls.logo_urls
    : currentLogoUrls.logo_url
      ? [currentLogoUrls.logo_url]
      : []
  const removedPaths = previousUrls
    .filter((url) => !parsed.data.logo_urls.includes(url))
    .map(customerLogoObjectPath)
    .filter((path): path is string => path !== null)
  if (removedPaths.length) {
    await createAdminClient().storage.from('customer-assets').remove(removedPaths)
  }

  revalidatePath('/customers')
  revalidatePath(`/customers/${id}`)
  return { ok: true, id }
}

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/

/**
 * 指派客户标记。仅管理员可操作，且颜色必须来自预定义标记库
 * （finance_customer_commission_tags），传 null 表示清除标记。
 */
export async function updateCustomerTagColor(
  id: string,
  tagColor: string | null,
): Promise<ActionResult & { id?: string; customer?: Customer }> {
  await requireAdmin()
  if (tagColor !== null && !HEX_COLOR_RE.test(tagColor)) {
    return { ok: false, error: '颜色格式错误' }
  }

  const supabase = await createClient()

  if (tagColor !== null) {
    const { data: tag, error: tagError } = await supabase
      .from('finance_customer_commission_tags')
      .select('tag_color')
      .eq('tag_color', tagColor)
      .maybeSingle()
    if (tagError) return { ok: false, error: tagError.message }
    if (!tag) return { ok: false, error: '标记不存在，请从预定义标记中选择' }
  }

  const { data, error } = await supabase
    .from('customers')
    .update({ tag_color: tagColor })
    .eq('id', id)
    .select('*')
    .single()
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers')
  return { ok: true, id, customer: data }
}

/**
 * 将客户移入回收站（软删除）。订单与 PI 的关联和快照全部保留，
 * 可在回收站恢复或彻底删除。数据库 RPC 会把写操作限定在本人客户或管理员。
 */
export async function deleteCustomer(
  id: string,
): Promise<ActionResult & { count?: number }> {
  await requireProfile()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('soft_delete_customers', {
    p_customer_ids: [id],
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers')
  return { ok: true, count: data ?? 0 }
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
 * 批量将客户移入回收站（软删除）。订单与 PI 的关联和快照全部保留。
 */
export async function bulkDeleteCustomers(
  ids: string[],
): Promise<ActionResult & { count?: number }> {
  await requireProfile()
  if (!ids.length) return { ok: false, error: '未选择任何客户' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('soft_delete_customers', {
    p_customer_ids: ids,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers')
  return { ok: true, count: data ?? 0 }
}

/** 从回收站恢复客户；恢复后重新出现在客户列表与订单绑定选择中。 */
export async function restoreCustomers(
  ids: string[],
): Promise<ActionResult & { count?: number }> {
  await requireProfile()
  if (!ids.length) return { ok: false, error: '未选择任何客户' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('restore_customers', {
    p_customer_ids: ids,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers')
  return { ok: true, count: data ?? 0 }
}

/**
 * 从回收站彻底删除客户（不可恢复）。存在定制产品档案或收款转账记录时数据库会拒绝，
 * 相关订单与 PI 改为解绑并保留名称快照。
 */
export async function purgeCustomers(
  ids: string[],
): Promise<ActionResult & { count?: number }> {
  await requireProfile()
  if (!ids.length) return { ok: false, error: '未选择任何客户' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('purge_customers', {
    p_customer_ids: ids,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers')
  revalidatePath('/pi/history')
  return { ok: true, count: data ?? 0 }
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
  const country = patch.country ? normalizeCountry(patch.country) : null
  if (country) update.country = country
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
