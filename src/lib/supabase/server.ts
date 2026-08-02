import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { SUPABASE_SERVER_URL, SUPABASE_STORAGE_KEY } from './urls'

/**
 * Server-side Supabase client bound to the request cookies.
 * Use inside Server Components, Server Actions and Route Handlers.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    SUPABASE_SERVER_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { storageKey: SUPABASE_STORAGE_KEY },
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[],
        ) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Called from a Server Component — cookies are read-only here.
            // Session refresh is handled by middleware, so this is safe to ignore.
          }
        },
      },
    },
  )
}
