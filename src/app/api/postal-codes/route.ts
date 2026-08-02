import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabase() {
  const url = process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!
  return createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

/**
 * GET /api/postal-codes?mode=city&country=US&q=New+York
 * GET /api/postal-codes?mode=postal&country=US&q=10001
 * GET /api/postal-codes?mode=parse&address=123+Main+St,+New+York,+NY+10001
 *
 * mode=city: given country + city prefix, return matching postal codes
 * mode=postal: given country + postal code, return city/state info
 * mode=parse: parse a full address string and return detected postal code + city
 */
export async function GET(request: NextRequest) {
  const supabase = getSupabase()
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('mode') || 'city'
  const country = searchParams.get('country')?.toUpperCase() || ''
  const q = searchParams.get('q')?.trim() || ''
  const address = searchParams.get('address')?.trim() || ''

  try {
    if (mode === 'city') {
      // Search by city name prefix within a country
      if (!country || !q) {
        return NextResponse.json({ results: [] })
      }
      const { data, error } = await supabase
        .from('postal_codes')
        .select('postal_code, place_name, state_name, state_code')
        .eq('country_code', country)
        .ilike('place_name', `${q}%`)
        .limit(20)

      if (error) throw error
      // Deduplicate by postal_code + place_name
      const seen = new Set<string>()
      const unique = (data || []).filter((row) => {
        const key = `${row.postal_code}|${row.place_name}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      return NextResponse.json({ results: unique })
    }

    if (mode === 'postal') {
      // Lookup by postal code (optionally within country)
      if (!q) {
        return NextResponse.json({ results: [] })
      }
      let query = supabase
        .from('postal_codes')
        .select('postal_code, place_name, state_name, state_code, country_code')
        .eq('postal_code', q)
        .limit(20)

      if (country) {
        query = query.eq('country_code', country)
      }

      const { data, error } = await query
      if (error) throw error
      return NextResponse.json({ results: data || [] })
    }

    if (mode === 'parse') {
      // Parse a full address to extract postal code
      const text = address || q
      if (!text) {
        return NextResponse.json({ postal_code: null, city: null, state: null })
      }

      // Try to extract postal code patterns from the address
      const postalPatterns = [
        // US ZIP: 5 digits or 5+4
        /\b(\d{5})(-\d{4})?\b/,
        // UK: A9 9AA, A99 9AA, A9A 9AA, AA9 9AA, AA99 9AA, AA9A 9AA
        /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i,
        // Canada: A9A 9A9
        /\b([A-Z]\d[A-Z]\s*\d[A-Z]\d)\b/i,
        // Europe (4-5 digits)
        /\b(\d{4,5})\b/,
        // Japan: 999-9999
        /\b(\d{3}-\d{4})\b/,
        // Australia: 4 digits
        /\b(\d{4})\b/,
      ]

      let detectedPostal: string | null = null
      for (const re of postalPatterns) {
        const m = text.match(re)
        if (m) {
          detectedPostal = m[1] || m[0]
          break
        }
      }

      if (!detectedPostal) {
        return NextResponse.json({ postal_code: null, city: null, state: null })
      }

      // Look up the postal code in DB
      let query = supabase
        .from('postal_codes')
        .select('postal_code, place_name, state_name, state_code, country_code')
        .eq('postal_code', detectedPostal.replace(/\s+/g, ' ').trim())
        .limit(5)

      if (country) {
        query = query.eq('country_code', country)
      }

      const { data, error } = await query
      if (error) throw error

      if (data && data.length > 0) {
        const match = data[0]
        return NextResponse.json({
          postal_code: match.postal_code,
          city: match.place_name,
          state: match.state_name,
          country_code: match.country_code,
          alternatives: data.length > 1 ? data.slice(1) : undefined,
        })
      }

      // Return detected code even if not in DB
      return NextResponse.json({
        postal_code: detectedPostal,
        city: null,
        state: null,
        note: 'Postal code detected but not found in database',
      })
    }

    return NextResponse.json({ error: 'Invalid mode' }, { status: 400 })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
