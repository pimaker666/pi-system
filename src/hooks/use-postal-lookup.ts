'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

interface PostalResult {
  postal_code: string
  place_name: string
  state_name: string | null
  state_code: string | null
  country_code?: string
}

interface UsePostalLookupOptions {
  country: string
  debounceMs?: number
}

// Country display name -> ISO 3166-1 alpha-2 code
const COUNTRY_TO_CODE: Record<string, string> = {
  USA: 'US', UK: 'GB', UAE: 'AE',
  Afghanistan: 'AF', Albania: 'AL', Algeria: 'DZ', Andorra: 'AD', Angola: 'AO',
  Argentina: 'AR', Armenia: 'AM', Australia: 'AU', Austria: 'AT', Azerbaijan: 'AZ',
  Bahamas: 'BS', Bahrain: 'BH', Bangladesh: 'BD', Barbados: 'BB', Belarus: 'BY',
  Belgium: 'BE', Belize: 'BZ', Benin: 'BJ', Bolivia: 'BO', Brazil: 'BR',
  Brunei: 'BN', Bulgaria: 'BG', Cambodia: 'KH', Cameroon: 'CM', Canada: 'CA',
  Chile: 'CL', China: 'CN', Colombia: 'CO', 'Costa Rica': 'CR', Croatia: 'HR',
  Cuba: 'CU', Cyprus: 'CY', Czechia: 'CZ', Denmark: 'DK', 'Dominican Republic': 'DO',
  Ecuador: 'EC', Egypt: 'EG', Estonia: 'EE', Ethiopia: 'ET', Finland: 'FI',
  France: 'FR', Georgia: 'GE', Germany: 'DE', Ghana: 'GH', Greece: 'GR',
  Guatemala: 'GT', Honduras: 'HN', 'Hong Kong': 'HK', Hungary: 'HU', Iceland: 'IS',
  India: 'IN', Indonesia: 'ID', Iran: 'IR', Iraq: 'IQ', Ireland: 'IE', Israel: 'IL',
  Italy: 'IT', Jamaica: 'JM', Japan: 'JP', Jordan: 'JO', Kazakhstan: 'KZ',
  Kenya: 'KE', Kuwait: 'KW', Laos: 'LA', Latvia: 'LV', Lebanon: 'LB',
  Lithuania: 'LT', Luxembourg: 'LU', Macau: 'MO', Malaysia: 'MY', Maldives: 'MV',
  Malta: 'MT', Mexico: 'MX', Moldova: 'MD', Mongolia: 'MN', Montenegro: 'ME',
  Morocco: 'MA', Myanmar: 'MM', Nepal: 'NP', Netherlands: 'NL', 'New Zealand': 'NZ',
  Nicaragua: 'NI', Nigeria: 'NG', Norway: 'NO', Oman: 'OM', Pakistan: 'PK',
  Panama: 'PA', Paraguay: 'PY', Peru: 'PE', Philippines: 'PH', Poland: 'PL',
  Portugal: 'PT', Qatar: 'QA', Romania: 'RO', Russia: 'RU', 'Saudi Arabia': 'SA',
  Senegal: 'SN', Serbia: 'RS', Singapore: 'SG', Slovakia: 'SK', Slovenia: 'SI',
  'South Africa': 'ZA', 'South Korea': 'KR', Spain: 'ES', 'Sri Lanka': 'LK',
  Sweden: 'SE', Switzerland: 'CH', Syria: 'SY', Taiwan: 'TW', Tanzania: 'TZ',
  Thailand: 'TH', Tunisia: 'TN', Turkey: 'TR', Ukraine: 'UA', Uruguay: 'UY',
  Uzbekistan: 'UZ', Venezuela: 'VE', Vietnam: 'VN',
}

function getCountryCode(country: string): string {
  if (!country) return ''
  // If already a 2-letter code
  if (/^[A-Z]{2}$/.test(country)) return country
  return COUNTRY_TO_CODE[country] || ''
}

/**
 * Hook for postal code <-> city bidirectional lookup.
 */
export function usePostalLookup({ country, debounceMs = 300 }: UsePostalLookupOptions) {
  const [cityResults, setCityResults] = useState<PostalResult[]>([])
  const [postalResults, setPostalResults] = useState<PostalResult[]>([])
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const countryCode = getCountryCode(country)

  const fetchResults = useCallback(
    async (mode: 'city' | 'postal', query: string) => {
      if (!query || query.length < 2 || !countryCode) {
        if (mode === 'city') setCityResults([])
        else setPostalResults([])
        return
      }

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setLoading(true)
      try {
        const params = new URLSearchParams({ mode, country: countryCode, q: query })
        const res = await fetch(`/api/postal-codes?${params}`, {
          signal: controller.signal,
        })
        if (!res.ok) throw new Error('Fetch failed')
        const data = await res.json()
        if (mode === 'city') setCityResults(data.results || [])
        else setPostalResults(data.results || [])
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          if (mode === 'city') setCityResults([])
          else setPostalResults([])
        }
      } finally {
        setLoading(false)
      }
    },
    [countryCode]
  )

  const lookupByCity = useCallback(
    (city: string) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => fetchResults('city', city), debounceMs)
    },
    [fetchResults, debounceMs]
  )

  const lookupByPostal = useCallback(
    (postalCode: string) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => fetchResults('postal', postalCode), debounceMs)
    },
    [fetchResults, debounceMs]
  )

  const parseAddress = useCallback(
    async (address: string): Promise<{ postal_code?: string; city?: string; state?: string } | null> => {
      if (!address || address.length < 3) return null
      try {
        const params = new URLSearchParams({
          mode: 'parse',
          address,
          ...(countryCode ? { country: countryCode } : {}),
        })
        const res = await fetch(`/api/postal-codes?${params}`)
        if (!res.ok) return null
        return await res.json()
      } catch {
        return null
      }
    },
    [countryCode]
  )

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return {
    cityResults,
    postalResults,
    loading,
    lookupByCity,
    lookupByPostal,
    parseAddress,
    clearResults: () => { setCityResults([]); setPostalResults([]) },
  }
}

export type { PostalResult }
