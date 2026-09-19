import { cn } from '@/lib/utils'
import { resolveCountryCode } from '@/lib/country-flags'

/**
 * Renders an SVG country flag next to a country/customer field. Uses flagcdn.com
 * SVGs so flags render identically across platforms (including Windows, where
 * flag emoji do not display). Returns null when the country is unrecognized, and
 * degrades gracefully to no icon if the image fails to load.
 */
export function CountryFlag({
  country,
  className,
}: {
  country: string | null | undefined
  className?: string
}) {
  const code = resolveCountryCode(country)
  if (!code) return null
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://flagcdn.com/${code}.svg`}
      alt=""
      title={country ?? ''}
      width={20}
      height={15}
      loading="lazy"
      referrerPolicy="no-referrer"
      className={cn('inline-block h-3.5 w-5 shrink-0 rounded-[2px] object-cover align-[-2px]', className)}
    />
  )
}
