'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth'
import { companySchema } from '@/schemas/company'
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
