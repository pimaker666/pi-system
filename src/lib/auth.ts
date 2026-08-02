import { cache } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import type { Profile } from '@/types'

/** Current authenticated user's profile, or null. Deduped per request. */
export const getCurrentProfile = cache(async (): Promise<Profile | null> => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  return (data as Profile) ?? null
})

/** Require a logged-in user, else redirect to login. */
export async function requireProfile(): Promise<Profile> {
  const profile = await getCurrentProfile()
  if (!profile) redirect('/login')
  return profile
}

/**
 * Require a logged-in AND admin-approved user.
 * Un-approved (pending) users are sent to the waiting-for-approval screen.
 */
export async function requireApproved(): Promise<Profile> {
  const profile = await requireProfile()
  if (profile.status !== 'approved') redirect('/pending')
  return profile
}

/** Require an admin, else redirect to dashboard. */
export async function requireAdmin(): Promise<Profile> {
  const profile = await requireApproved()
  if (profile.role !== 'admin') redirect('/dashboard')
  return profile
}
