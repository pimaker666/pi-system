import { canonicalCountry } from './parse-customer'

// Canonical display name (as produced by parse-customer's COUNTRY_ALIASES) ->
// ISO 3166-1 alpha-2 code (lowercase, matches flagcdn.com file names).
const COUNTRY_ISO2: Record<string, string> = {
  USA: 'us', UK: 'gb', UAE: 'ae',

  // Africa
  Algeria: 'dz', Angola: 'ao', Benin: 'bj', Botswana: 'bw', 'Burkina Faso': 'bf',
  Burundi: 'bi', 'Cape Verde': 'cv', Cameroon: 'cm', 'Central African Republic': 'cf',
  Chad: 'td', Comoros: 'km', 'DR Congo': 'cd', Congo: 'cg', Djibouti: 'dj', Egypt: 'eg',
  'Equatorial Guinea': 'gq', Eritrea: 'er', Eswatini: 'sz', Ethiopia: 'et', Gabon: 'ga',
  Gambia: 'gm', Ghana: 'gh', 'Guinea-Bissau': 'gw', Guinea: 'gn', 'Ivory Coast': 'ci',
  Kenya: 'ke', Lesotho: 'ls', Liberia: 'lr', Libya: 'ly', Madagascar: 'mg', Malawi: 'mw',
  Mali: 'ml', Mauritania: 'mr', Mauritius: 'mu', Morocco: 'ma', Mozambique: 'mz',
  Namibia: 'na', Niger: 'ne', Nigeria: 'ng', Rwanda: 'rw', 'Sao Tome and Principe': 'st',
  Senegal: 'sn', Seychelles: 'sc', 'Sierra Leone': 'sl', Somalia: 'so', 'South Africa': 'za',
  'South Sudan': 'ss', Sudan: 'sd', Tanzania: 'tz', Togo: 'tg', Tunisia: 'tn', Uganda: 'ug',
  Zambia: 'zm', Zimbabwe: 'zw',

  // Asia
  Afghanistan: 'af', Armenia: 'am', Azerbaijan: 'az', Bahrain: 'bh', Bangladesh: 'bd',
  Bhutan: 'bt', Brunei: 'bn', Cambodia: 'kh', China: 'cn', Cyprus: 'cy', Georgia: 'ge',
  'Hong Kong': 'hk', India: 'in', Indonesia: 'id', Iran: 'ir', Iraq: 'iq', Israel: 'il',
  Japan: 'jp', Jordan: 'jo', Kazakhstan: 'kz', Kuwait: 'kw', Kyrgyzstan: 'kg', Laos: 'la',
  Lebanon: 'lb', Macau: 'mo', Malaysia: 'my', Maldives: 'mv', Mongolia: 'mn', Myanmar: 'mm',
  Nepal: 'np', 'North Korea': 'kp', Oman: 'om', Pakistan: 'pk', Palestine: 'ps',
  Philippines: 'ph', Qatar: 'qa', 'Saudi Arabia': 'sa', Singapore: 'sg', 'South Korea': 'kr',
  'Sri Lanka': 'lk', Syria: 'sy', Taiwan: 'tw', Tajikistan: 'tj', Thailand: 'th',
  'Timor-Leste': 'tl', Turkey: 'tr', Turkmenistan: 'tm', Uzbekistan: 'uz', Vietnam: 'vn',
  Yemen: 'ye',

  // Europe
  Albania: 'al', Andorra: 'ad', Austria: 'at', Belarus: 'by', Belgium: 'be',
  'Bosnia and Herzegovina': 'ba', Bulgaria: 'bg', Croatia: 'hr', Czechia: 'cz', Denmark: 'dk',
  Estonia: 'ee', Finland: 'fi', France: 'fr', Germany: 'de', Greece: 'gr', Hungary: 'hu',
  Iceland: 'is', Ireland: 'ie', Italy: 'it', Kosovo: 'xk', Latvia: 'lv', Liechtenstein: 'li',
  Lithuania: 'lt', Luxembourg: 'lu', Malta: 'mt', Moldova: 'md', Monaco: 'mc', Montenegro: 'me',
  Netherlands: 'nl', 'North Macedonia': 'mk', Norway: 'no', Poland: 'pl', Portugal: 'pt',
  Romania: 'ro', Russia: 'ru', 'San Marino': 'sm', Serbia: 'rs', Slovakia: 'sk', Slovenia: 'si',
  Spain: 'es', Sweden: 'se', Switzerland: 'ch', Ukraine: 'ua', Vatican: 'va',

  // North America & Caribbean
  'Antigua and Barbuda': 'ag', Bahamas: 'bs', Barbados: 'bb', Belize: 'bz', Canada: 'ca',
  'Costa Rica': 'cr', Cuba: 'cu', Dominica: 'dm', 'Dominican Republic': 'do', 'El Salvador': 'sv',
  Grenada: 'gd', Guatemala: 'gt', Haiti: 'ht', Honduras: 'hn', Jamaica: 'jm', Mexico: 'mx',
  Nicaragua: 'ni', Panama: 'pa', 'Puerto Rico': 'pr', 'Saint Kitts and Nevis': 'kn',
  'Saint Lucia': 'lc', 'Saint Vincent and the Grenadines': 'vc', 'Trinidad and Tobago': 'tt',

  // South America
  Argentina: 'ar', Bolivia: 'bo', Brazil: 'br', Chile: 'cl', Colombia: 'co', Ecuador: 'ec',
  Guyana: 'gy', Paraguay: 'py', Peru: 'pe', Suriname: 'sr', Uruguay: 'uy', Venezuela: 've',

  // Oceania
  Australia: 'au', Fiji: 'fj', Kiribati: 'ki', 'Marshall Islands': 'mh', Micronesia: 'fm',
  Nauru: 'nr', 'New Zealand': 'nz', Palau: 'pw', 'Papua New Guinea': 'pg', Samoa: 'ws',
  'Solomon Islands': 'sb', Tonga: 'to', Tuvalu: 'tv', Vanuatu: 'vu',
}

/**
 * Resolve a country string (free text / Chinese alias / canonical name) to its
 * ISO 3166-1 alpha-2 code for flag rendering, or null when unrecognized.
 */
export function resolveCountryCode(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const iso2 = trimmed.toLowerCase()
  if (Object.values(COUNTRY_ISO2).includes(iso2)) return iso2
  if (COUNTRY_ISO2[trimmed]) return COUNTRY_ISO2[trimmed]
  const canon = canonicalCountry(trimmed)
  if (canon && COUNTRY_ISO2[canon]) return COUNTRY_ISO2[canon]
  return null
}

const chineseCountryNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' })

export function formatCountryName(raw: string | null | undefined): string {
  if (!raw?.trim()) return '—'
  const code = resolveCountryCode(raw)
  return code ? chineseCountryNames.of(code.toUpperCase()) ?? raw : raw
}
