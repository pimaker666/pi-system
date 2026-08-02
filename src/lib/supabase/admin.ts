import { createClient as createSupabaseClient } from '@supabase/supabase-js'

/**
 * Admin client using the service_role key. NEVER expose this to the browser.
 * Bypasses RLS — only call from trusted server code for privileged operations
 * (e.g. reading arbitrary profiles, generating signed URLs).
 */
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  )
}
