import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { SUPABASE_SERVER_URL, SUPABASE_STORAGE_KEY } from './lib/supabase/urls'

const PUBLIC_PATHS = ['/login', '/signup', '/auth']

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    SUPABASE_SERVER_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { storageKey: SUPABASE_STORAGE_KEY },
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[],
        ) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  // Refresh the session so Server Components always see fresh auth state.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p))

  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('redirect', pathname)
    return NextResponse.redirect(url)
  }

  if (user && (pathname === '/login' || pathname === '/signup')) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: ['/((?!supabase|_next/static|_next/image|favicon.ico|fonts|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
