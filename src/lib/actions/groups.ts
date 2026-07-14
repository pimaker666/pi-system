'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireProfile } from '@/lib/auth'
import { customerGroupSchema } from '@/schemas/customer'
import type { ActionResult } from './products'

function parseGroup(formData: FormData) {
  return customerGroupSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') || '',
  })
}

export async function createGroup(formData: FormData): Promise<ActionResult> {
  const profile = await requireProfile()
  const parsed = parseGroup(formData)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('customer_groups').insert({
    name: parsed.data.name,
    description: parsed.data.description || null,
    created_by: profile.id,
  })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers/groups')
  revalidatePath('/customers')
  return { ok: true }
}

export async function updateGroup(id: string, formData: FormData): Promise<ActionResult> {
  await requireProfile()
  const parsed = parseGroup(formData)
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('customer_groups')
    .update({ name: parsed.data.name, description: parsed.data.description || null })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers/groups')
  return { ok: true }
}

export async function deleteGroup(id: string): Promise<ActionResult> {
  await requireProfile()
  const supabase = await createClient()
  // customers.group_id is ON DELETE SET NULL, so members become ungrouped.
  const { error } = await supabase.from('customer_groups').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/customers/groups')
  revalidatePath('/customers')
  return { ok: true }
}
