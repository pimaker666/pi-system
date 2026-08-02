'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin, requireProfile } from '@/lib/auth'
import { companySchema, companyProfileSchema } from '@/schemas/company'
import type { ActionResult } from './products'

export async function upsertCompanySettings(formData: FormData): Promise<ActionResult> {
  await requireAdmin()

  const parsed = companySchema.safeParse({
    company_name: formData.get('company_name'),
    address: formData.get('address') || '',
    phone: formData.get('phone') || '',
    email: formData.get('email') || '',
    website: formData.get('website') || '',
    logo_url: formData.get('logo_url') || '',
    accent_color: formData.get('accent_color') || '',
    bank_name: formData.get('bank_name') || '',
    bank_account: formData.get('bank_account') || '',
    bank_swift: formData.get('bank_swift') || '',
    bank_address: formData.get('bank_address') || '',
    default_terms: formData.get('default_terms') || '',
  })
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  // Single-row settings table keyed on id = 1.
  const { error } = await supabase.from('company_settings').upsert({
    id: 1,
    company_name: parsed.data.company_name,
    address: parsed.data.address || null,
    phone: parsed.data.phone || null,
    email: parsed.data.email || null,
    website: parsed.data.website || null,
    logo_url: parsed.data.logo_url || null,
    accent_color: parsed.data.accent_color || null,
    bank_name: parsed.data.bank_name || null,
    bank_account: parsed.data.bank_account || null,
    bank_swift: parsed.data.bank_swift || null,
    bank_address: parsed.data.bank_address || null,
    default_terms: parsed.data.default_terms || null,
    updated_at: new Date().toISOString(),
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/settings')
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Per-account company profiles (each account manages its own; one is active).
// ---------------------------------------------------------------------------

function parseCompanyProfile(formData: FormData) {
  return companyProfileSchema.safeParse({
    label: formData.get('label'),
    company_name: formData.get('company_name'),
    address: formData.get('address') || '',
    phone: formData.get('phone') || '',
    email: formData.get('email') || '',
    website: formData.get('website') || '',
    logo_url: formData.get('logo_url') || '',
    accent_color: formData.get('accent_color') || '',
    bank_name: formData.get('bank_name') || '',
    bank_account: formData.get('bank_account') || '',
    bank_swift: formData.get('bank_swift') || '',
    bank_address: formData.get('bank_address') || '',
    default_terms: formData.get('default_terms') || '',
  })
}

function profileValues(data: ReturnType<typeof companyProfileSchema.parse>) {
  return {
    label: data.label,
    company_name: data.company_name,
    address: data.address || null,
    phone: data.phone || null,
    email: data.email || null,
    website: data.website || null,
    logo_url: data.logo_url || null,
    accent_color: data.accent_color || null,
    bank_name: data.bank_name || null,
    bank_account: data.bank_account || null,
    bank_swift: data.bank_swift || null,
    bank_address: data.bank_address || null,
    default_terms: data.default_terms || null,
  }
}

export async function createCompanyProfile(formData: FormData): Promise<ActionResult> {
  const profile = await requireProfile()
  const parsed = parseCompanyProfile(formData)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  // First profile for this account becomes active automatically.
  const { count } = await supabase
    .from('company_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('created_by', profile.id)

  const { error } = await supabase.from('company_profiles').insert({
    ...profileValues(parsed.data),
    created_by: profile.id,
    is_active: (count ?? 0) === 0,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/settings')
  return { ok: true }
}

export async function updateCompanyProfile(
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  await requireProfile()
  const parsed = parseCompanyProfile(formData)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('company_profiles')
    .update({ ...profileValues(parsed.data), updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/settings')
  return { ok: true }
}

export async function deleteCompanyProfile(id: string): Promise<ActionResult> {
  await requireProfile()
  const supabase = await createClient()
  const { error } = await supabase.from('company_profiles').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/settings')
  return { ok: true }
}

export async function setActiveCompanyProfile(id: string): Promise<ActionResult> {
  const profile = await requireProfile()
  const supabase = await createClient()

  // Only one active profile per account: clear the rest, then set the chosen one.
  const { error: clearError } = await supabase
    .from('company_profiles')
    .update({ is_active: false })
    .eq('created_by', profile.id)
    .neq('id', id)
  if (clearError) return { ok: false, error: clearError.message }

  const { error } = await supabase
    .from('company_profiles')
    .update({ is_active: true })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/settings')
  return { ok: true }
}
