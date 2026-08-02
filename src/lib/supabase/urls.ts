/**
 * Supabase base-URL resolution split by execution context.
 *
 * The BROWSER must reach Supabase over its publicly reachable address (e.g. a
 * Tailscale Funnel HTTPS URL), so client-side code uses NEXT_PUBLIC_SUPABASE_URL.
 *
 * SERVER-side code (Server Components, Server Actions, middleware, the admin
 * client) runs inside the NAS / container network. It should talk to Supabase
 * over the fast internal address to avoid hair-pinning out to the public relay
 * and back on every request. It therefore prefers SUPABASE_INTERNAL_URL when
 * set, falling back to the public URL for local/dev setups where the two are
 * identical (e.g. Vercel, or a plain LAN-only deployment).
 *
 * SUPABASE_INTERNAL_URL is provided at BOTH build time (Dockerfile ARG/ENV, so
 * it is inlined into the Edge middleware bundle) and run time (compose
 * environment, for the Node standalone server). Keep both in sync.
 */
export const SUPABASE_SERVER_URL =
  process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!

/**
 * Fixed Supabase auth cookie/storage key shared by BOTH the browser and server
 * clients.
 *
 * supabase-js normally derives this from the client URL's hostname
 * (`sb-<host-first-label>-auth-token`). Since the browser client is now pointed
 * at the same-origin proxy (`<origin>/supabase`, host `pi…`) while the server
 * client talks to the internal Supabase host (`192.168.0.5`), the two would
 * otherwise derive DIFFERENT keys (`sb-pi-auth-token` vs `sb-192-auth-token`)
 * and fail to share the session cookie — leaving the browser client
 * unauthenticated so uploads/inserts get rejected by RLS. Pin one identical key
 * everywhere. We derive it from NEXT_PUBLIC_SUPABASE_URL (the internal host,
 * inlined into both the browser and server bundles) so it equals the
 * historically-used `sb-192-auth-token` and existing sessions stay valid.
 */
function refFromUrl(u: string | undefined): string {
  try {
    return new URL(u ?? '').hostname.split('.')[0] || 'localhost'
  } catch {
    return 'localhost'
  }
}

export const SUPABASE_STORAGE_KEY = `sb-${refFromUrl(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
)}-auth-token`
