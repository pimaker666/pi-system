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
