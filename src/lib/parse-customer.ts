export interface ParsedCustomer {
  name?: string
  company?: string
  contact_person?: string
  country?: string
  email?: string
  phone?: string
  address?: string
  city?: string
  state?: string
  postal_code?: string
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
// Phone: optional +, then digits/space/dash/paren/dot, needs >= 7 digits overall.
const PHONE_RE = /(\+?\d[\d\s().-]{5,}\d)/

const LABELS: Record<keyof ParsedCustomer, string[]> = {
  name: ['客户名称', '客户名', '客户', '姓名', '收件人', 'name', 'customer', 'customer name'],
  company: ['公司名称', '公司', '单位', '企业', 'company', 'company name', 'firm'],
  contact_person: ['联系人姓名', '联系人', 'contact person', 'contact', 'attn', 'attention'],
  country: ['国家/地区', '国家', '地区', 'country', 'region', 'nation'],
  email: ['电子邮箱', '邮箱', '邮件', 'email', 'e-mail', 'mail'],
  phone: ['联系电话', '手机号', '手机', '电话', 'telephone', 'tel', 'phone', 'mobile', 'cell', 'whatsapp', 'wechat', 'phone number'],
  address: ['详细地址', '地址', 'address', 'addr', 'add'],
  city: ['城市', '市', 'city', 'town'],
  state: ['州', '省', '省份', 'state', 'province', 'region'],
  postal_code: ['邮编', '邮政编码', '邮政编号', 'zip', 'zip code', 'zipcode', 'postal code', 'postal', 'postcode', 'post code'],
}

// Address hint keywords (used when a line has no label).
const ADDRESS_HINTS = [
  'road', 'street', 'st.', 'ave', 'avenue', 'district', 'province', 'city',
  'town', 'building', 'floor', 'room', 'no.', 'zip', 'postal',
  '路', '街', '号', '区', '市', '省', '镇', '栋', '室', '楼', '大道', '巷', '弄',
]

// Payment-method noise. Lines that are just a payment channel (PayPal / Zelle /
// wire / 支付宝 ...) must never become the customer name or company.
const PAYMENT_HINTS = [
  'paypal', 'zelle', 'venmo', 'cashapp', 'cash app', 'wire transfer', 'wire',
  'western union', 'moneygram', 'money gram', 'bank transfer', 't/t', 'swift',
  'iban', 'bitcoin', 'btc', 'usdt', 'crypto', 'payoneer', 'stripe',
  '支付宝', '微信', 'wechat pay', '银行转账', '电汇',
]

// A street line: starts with a house number + word, or contains a common street
// suffix as a whole word. Word boundaries avoid matching inside ordinary words.
const STREET_RE =
  /(^\s*\d+\s*[-,]?\s*[A-Za-z])|(\b(rd|road|st|street|ave|avenue|blvd|boulevard|ln|lane|dr|drive|ct|court|way|pkwy|parkway|hwy|highway|apt|apartment|suite|ste|unit|fl|floor|rm|room|building|block|po\s?box)\b\.?)/i

// US-style locality line: "City, ST" or "City, ST 12345" (state = 2 letters).
const CITY_STATE_RE = /^[A-Za-z][A-Za-z .'-]*,\s*[A-Za-z]{2}\.?(\s+\d{5}(-\d{4})?)?$/

// A standalone postal / ZIP code line.
const ZIP_RE = /^\d{4,6}(-\d{4})?$/

// Country detection: alias (lowercase for latin) -> canonical display name.
// Latin aliases are matched on word boundaries to avoid false positives
// (e.g. "oman" inside "Romania"); CJK aliases are matched as substrings.
// Bare 2-letter forms like "us" are intentionally omitted (they collide with
// common words such as "contact us"); explicit forms like "u.s." are kept.
const COUNTRY_ALIASES: Record<string, string> = {
  // ---- Special common abbreviations ----
  usa: 'USA', 'u.s.a': 'USA', 'u.s.a.': 'USA', 'u.s.': 'USA',
  'united states': 'USA', 'united states of america': 'USA', america: 'USA', 美国: 'USA',
  uk: 'UK', 'u.k.': 'UK', 'united kingdom': 'UK', 'great britain': 'UK', britain: 'UK', england: 'UK', 英国: 'UK', 英格兰: 'UK',
  uae: 'UAE', 'united arab emirates': 'UAE', dubai: 'UAE', 'abu dhabi': 'UAE', 阿联酋: 'UAE', 迪拜: 'UAE', 阿拉伯联合酋长国: 'UAE',

  // ---- Africa ----
  algeria: 'Algeria', 阿尔及利亚: 'Algeria',
  angola: 'Angola', 安哥拉: 'Angola',
  benin: 'Benin', 贝宁: 'Benin',
  botswana: 'Botswana', 博茨瓦纳: 'Botswana',
  'burkina faso': 'Burkina Faso', 布基纳法索: 'Burkina Faso',
  burundi: 'Burundi', 布隆迪: 'Burundi',
  'cabo verde': 'Cape Verde', 'cape verde': 'Cape Verde', 佛得角: 'Cape Verde',
  cameroon: 'Cameroon', 喀麦隆: 'Cameroon',
  'central african republic': 'Central African Republic', 中非: 'Central African Republic', 中非共和国: 'Central African Republic',
  chad: 'Chad', 乍得: 'Chad',
  comoros: 'Comoros', 科摩罗: 'Comoros',
  'democratic republic of the congo': 'DR Congo', 'dr congo': 'DR Congo', drc: 'DR Congo', 刚果民主共和国: 'DR Congo', '刚果(金)': 'DR Congo', 刚果金: 'DR Congo',
  'republic of the congo': 'Congo', congo: 'Congo', 刚果: 'Congo', '刚果(布)': 'Congo', 刚果布: 'Congo',
  djibouti: 'Djibouti', 吉布提: 'Djibouti',
  egypt: 'Egypt', 埃及: 'Egypt',
  'equatorial guinea': 'Equatorial Guinea', 赤道几内亚: 'Equatorial Guinea',
  eritrea: 'Eritrea', 厄立特里亚: 'Eritrea',
  eswatini: 'Eswatini', swaziland: 'Eswatini', 斯威士兰: 'Eswatini', 斯瓦蒂尼: 'Eswatini',
  ethiopia: 'Ethiopia', 埃塞俄比亚: 'Ethiopia',
  gabon: 'Gabon', 加蓬: 'Gabon',
  gambia: 'Gambia', 冈比亚: 'Gambia',
  ghana: 'Ghana', 加纳: 'Ghana',
  'guinea-bissau': 'Guinea-Bissau', 'guinea bissau': 'Guinea-Bissau', 几内亚比绍: 'Guinea-Bissau',
  guinea: 'Guinea', 几内亚: 'Guinea',
  'ivory coast': 'Ivory Coast', "cote d'ivoire": 'Ivory Coast', "côte d'ivoire": 'Ivory Coast', 科特迪瓦: 'Ivory Coast',
  kenya: 'Kenya', 肯尼亚: 'Kenya',
  lesotho: 'Lesotho', 莱索托: 'Lesotho',
  liberia: 'Liberia', 利比里亚: 'Liberia',
  libya: 'Libya', 利比亚: 'Libya',
  madagascar: 'Madagascar', 马达加斯加: 'Madagascar',
  malawi: 'Malawi', 马拉维: 'Malawi',
  mali: 'Mali', 马里: 'Mali',
  mauritania: 'Mauritania', 毛里塔尼亚: 'Mauritania',
  mauritius: 'Mauritius', 毛里求斯: 'Mauritius',
  morocco: 'Morocco', 摩洛哥: 'Morocco',
  mozambique: 'Mozambique', 莫桑比克: 'Mozambique',
  namibia: 'Namibia', 纳米比亚: 'Namibia',
  niger: 'Niger', 尼日尔: 'Niger',
  nigeria: 'Nigeria', 尼日利亚: 'Nigeria',
  rwanda: 'Rwanda', 卢旺达: 'Rwanda',
  'sao tome and principe': 'Sao Tome and Principe', 圣多美和普林西比: 'Sao Tome and Principe',
  senegal: 'Senegal', 塞内加尔: 'Senegal',
  seychelles: 'Seychelles', 塞舌尔: 'Seychelles',
  'sierra leone': 'Sierra Leone', 塞拉利昂: 'Sierra Leone',
  somalia: 'Somalia', 索马里: 'Somalia',
  'south africa': 'South Africa', 南非: 'South Africa',
  'south sudan': 'South Sudan', 南苏丹: 'South Sudan',
  sudan: 'Sudan', 苏丹: 'Sudan',
  tanzania: 'Tanzania', 坦桑尼亚: 'Tanzania',
  togo: 'Togo', 多哥: 'Togo',
  tunisia: 'Tunisia', 突尼斯: 'Tunisia',
  uganda: 'Uganda', 乌干达: 'Uganda',
  zambia: 'Zambia', 赞比亚: 'Zambia',
  zimbabwe: 'Zimbabwe', 津巴布韦: 'Zimbabwe',

  // ---- Asia ----
  afghanistan: 'Afghanistan', 阿富汗: 'Afghanistan',
  armenia: 'Armenia', 亚美尼亚: 'Armenia',
  azerbaijan: 'Azerbaijan', 阿塞拜疆: 'Azerbaijan',
  bahrain: 'Bahrain', 巴林: 'Bahrain',
  bangladesh: 'Bangladesh', 孟加拉国: 'Bangladesh', 孟加拉: 'Bangladesh',
  bhutan: 'Bhutan', 不丹: 'Bhutan',
  brunei: 'Brunei', 文莱: 'Brunei',
  cambodia: 'Cambodia', 柬埔寨: 'Cambodia',
  china: 'China', 'p.r.china': 'China', 'pr china': 'China', prc: 'China', 'mainland china': 'China', 中国: 'China', 中华人民共和国: 'China', 中国大陆: 'China',
  cyprus: 'Cyprus', 塞浦路斯: 'Cyprus',
  georgia: 'Georgia', 格鲁吉亚: 'Georgia',
  'hong kong': 'Hong Kong', hongkong: 'Hong Kong', 香港: 'Hong Kong',
  india: 'India', 印度: 'India',
  indonesia: 'Indonesia', 印度尼西亚: 'Indonesia', 印尼: 'Indonesia',
  iran: 'Iran', 伊朗: 'Iran',
  iraq: 'Iraq', 伊拉克: 'Iraq',
  israel: 'Israel', 以色列: 'Israel',
  japan: 'Japan', 日本: 'Japan',
  jordan: 'Jordan', 约旦: 'Jordan',
  kazakhstan: 'Kazakhstan', 哈萨克斯坦: 'Kazakhstan',
  kuwait: 'Kuwait', 科威特: 'Kuwait',
  kyrgyzstan: 'Kyrgyzstan', 吉尔吉斯斯坦: 'Kyrgyzstan',
  laos: 'Laos', 老挝: 'Laos',
  lebanon: 'Lebanon', 黎巴嫩: 'Lebanon',
  macau: 'Macau', macao: 'Macau', 澳门: 'Macau',
  malaysia: 'Malaysia', 马来西亚: 'Malaysia',
  maldives: 'Maldives', 马尔代夫: 'Maldives',
  mongolia: 'Mongolia', 蒙古: 'Mongolia', 蒙古国: 'Mongolia',
  myanmar: 'Myanmar', burma: 'Myanmar', 缅甸: 'Myanmar',
  nepal: 'Nepal', 尼泊尔: 'Nepal',
  'north korea': 'North Korea', dprk: 'North Korea', 朝鲜: 'North Korea',
  oman: 'Oman', 阿曼: 'Oman',
  pakistan: 'Pakistan', 巴基斯坦: 'Pakistan',
  palestine: 'Palestine', 巴勒斯坦: 'Palestine',
  philippines: 'Philippines', 菲律宾: 'Philippines',
  qatar: 'Qatar', 卡塔尔: 'Qatar',
  'saudi arabia': 'Saudi Arabia', saudi: 'Saudi Arabia', 沙特: 'Saudi Arabia', 沙特阿拉伯: 'Saudi Arabia',
  singapore: 'Singapore', 新加坡: 'Singapore',
  'south korea': 'South Korea', 'korea, south': 'South Korea', korea: 'South Korea', 韩国: 'South Korea', 南韩: 'South Korea',
  'sri lanka': 'Sri Lanka', 斯里兰卡: 'Sri Lanka',
  syria: 'Syria', 叙利亚: 'Syria',
  taiwan: 'Taiwan', 台湾: 'Taiwan', 中国台湾: 'Taiwan',
  tajikistan: 'Tajikistan', 塔吉克斯坦: 'Tajikistan',
  thailand: 'Thailand', 泰国: 'Thailand',
  'timor-leste': 'Timor-Leste', 'east timor': 'Timor-Leste', 东帝汶: 'Timor-Leste',
  turkey: 'Turkey', turkiye: 'Turkey', türkiye: 'Turkey', 土耳其: 'Turkey',
  turkmenistan: 'Turkmenistan', 土库曼斯坦: 'Turkmenistan',
  uzbekistan: 'Uzbekistan', 乌兹别克斯坦: 'Uzbekistan',
  vietnam: 'Vietnam', 'viet nam': 'Vietnam', 越南: 'Vietnam',
  yemen: 'Yemen', 也门: 'Yemen',

  // ---- Europe ----
  albania: 'Albania', 阿尔巴尼亚: 'Albania',
  andorra: 'Andorra', 安道尔: 'Andorra',
  austria: 'Austria', 奥地利: 'Austria',
  belarus: 'Belarus', 白俄罗斯: 'Belarus',
  belgium: 'Belgium', 比利时: 'Belgium',
  'bosnia and herzegovina': 'Bosnia and Herzegovina', bosnia: 'Bosnia and Herzegovina', 波斯尼亚和黑塞哥维那: 'Bosnia and Herzegovina', 波黑: 'Bosnia and Herzegovina',
  bulgaria: 'Bulgaria', 保加利亚: 'Bulgaria',
  croatia: 'Croatia', 克罗地亚: 'Croatia',
  czechia: 'Czechia', 'czech republic': 'Czechia', czech: 'Czechia', 捷克: 'Czechia',
  denmark: 'Denmark', 丹麦: 'Denmark',
  estonia: 'Estonia', 爱沙尼亚: 'Estonia',
  finland: 'Finland', 芬兰: 'Finland',
  france: 'France', 法国: 'France',
  germany: 'Germany', deutschland: 'Germany', 德国: 'Germany',
  greece: 'Greece', 希腊: 'Greece',
  hungary: 'Hungary', 匈牙利: 'Hungary',
  iceland: 'Iceland', 冰岛: 'Iceland',
  ireland: 'Ireland', 爱尔兰: 'Ireland',
  italy: 'Italy', 意大利: 'Italy',
  kosovo: 'Kosovo', 科索沃: 'Kosovo',
  latvia: 'Latvia', 拉脱维亚: 'Latvia',
  liechtenstein: 'Liechtenstein', 列支敦士登: 'Liechtenstein',
  lithuania: 'Lithuania', 立陶宛: 'Lithuania',
  luxembourg: 'Luxembourg', 卢森堡: 'Luxembourg',
  malta: 'Malta', 马耳他: 'Malta',
  moldova: 'Moldova', 摩尔多瓦: 'Moldova',
  monaco: 'Monaco', 摩纳哥: 'Monaco',
  montenegro: 'Montenegro', 黑山: 'Montenegro',
  netherlands: 'Netherlands', holland: 'Netherlands', 荷兰: 'Netherlands',
  'north macedonia': 'North Macedonia', macedonia: 'North Macedonia', 北马其顿: 'North Macedonia', 马其顿: 'North Macedonia',
  norway: 'Norway', 挪威: 'Norway',
  poland: 'Poland', 波兰: 'Poland',
  portugal: 'Portugal', 葡萄牙: 'Portugal',
  romania: 'Romania', 罗马尼亚: 'Romania',
  russia: 'Russia', 'russian federation': 'Russia', 俄罗斯: 'Russia', 俄国: 'Russia',
  'san marino': 'San Marino', 圣马力诺: 'San Marino',
  serbia: 'Serbia', 塞尔维亚: 'Serbia',
  slovakia: 'Slovakia', 斯洛伐克: 'Slovakia',
  slovenia: 'Slovenia', 斯洛文尼亚: 'Slovenia',
  spain: 'Spain', 西班牙: 'Spain',
  sweden: 'Sweden', 瑞典: 'Sweden',
  switzerland: 'Switzerland', 瑞士: 'Switzerland',
  ukraine: 'Ukraine', 乌克兰: 'Ukraine',
  'vatican city': 'Vatican', vatican: 'Vatican', 梵蒂冈: 'Vatican',

  // ---- North America & Caribbean ----
  'antigua and barbuda': 'Antigua and Barbuda', antigua: 'Antigua and Barbuda', 安提瓜和巴布达: 'Antigua and Barbuda',
  bahamas: 'Bahamas', 巴哈马: 'Bahamas',
  barbados: 'Barbados', 巴巴多斯: 'Barbados',
  belize: 'Belize', 伯利兹: 'Belize',
  canada: 'Canada', 加拿大: 'Canada',
  'costa rica': 'Costa Rica', 哥斯达黎加: 'Costa Rica',
  cuba: 'Cuba', 古巴: 'Cuba',
  dominica: 'Dominica', 多米尼克: 'Dominica',
  'dominican republic': 'Dominican Republic', 多米尼加: 'Dominican Republic',
  'el salvador': 'El Salvador', 萨尔瓦多: 'El Salvador',
  grenada: 'Grenada', 格林纳达: 'Grenada',
  guatemala: 'Guatemala', 危地马拉: 'Guatemala',
  haiti: 'Haiti', 海地: 'Haiti',
  honduras: 'Honduras', 洪都拉斯: 'Honduras',
  jamaica: 'Jamaica', 牙买加: 'Jamaica',
  mexico: 'Mexico', 墨西哥: 'Mexico',
  nicaragua: 'Nicaragua', 尼加拉瓜: 'Nicaragua',
  panama: 'Panama', 巴拿马: 'Panama',
  'puerto rico': 'Puerto Rico', 波多黎各: 'Puerto Rico',
  'saint kitts and nevis': 'Saint Kitts and Nevis', 圣基茨和尼维斯: 'Saint Kitts and Nevis',
  'saint lucia': 'Saint Lucia', 圣卢西亚: 'Saint Lucia',
  'saint vincent and the grenadines': 'Saint Vincent and the Grenadines', 圣文森特和格林纳丁斯: 'Saint Vincent and the Grenadines',
  'trinidad and tobago': 'Trinidad and Tobago', trinidad: 'Trinidad and Tobago', 特立尼达和多巴哥: 'Trinidad and Tobago',

  // ---- South America ----
  argentina: 'Argentina', 阿根廷: 'Argentina',
  bolivia: 'Bolivia', 玻利维亚: 'Bolivia',
  brazil: 'Brazil', brasil: 'Brazil', 巴西: 'Brazil',
  chile: 'Chile', 智利: 'Chile',
  colombia: 'Colombia', 哥伦比亚: 'Colombia',
  ecuador: 'Ecuador', 厄瓜多尔: 'Ecuador',
  guyana: 'Guyana', 圭亚那: 'Guyana',
  paraguay: 'Paraguay', 巴拉圭: 'Paraguay',
  peru: 'Peru', 秘鲁: 'Peru',
  suriname: 'Suriname', 苏里南: 'Suriname',
  uruguay: 'Uruguay', 乌拉圭: 'Uruguay',
  venezuela: 'Venezuela', 委内瑞拉: 'Venezuela',

  // ---- Oceania ----
  australia: 'Australia', 澳大利亚: 'Australia', 澳洲: 'Australia',
  fiji: 'Fiji', 斐济: 'Fiji',
  kiribati: 'Kiribati', 基里巴斯: 'Kiribati',
  'marshall islands': 'Marshall Islands', 马绍尔群岛: 'Marshall Islands',
  micronesia: 'Micronesia', 密克罗尼西亚: 'Micronesia',
  nauru: 'Nauru', 瑙鲁: 'Nauru',
  'new zealand': 'New Zealand', 新西兰: 'New Zealand',
  palau: 'Palau', 帕劳: 'Palau',
  'papua new guinea': 'Papua New Guinea', 巴布亚新几内亚: 'Papua New Guinea',
  samoa: 'Samoa', 萨摩亚: 'Samoa',
  'solomon islands': 'Solomon Islands', 所罗门群岛: 'Solomon Islands',
  tonga: 'Tonga', 汤加: 'Tonga',
  tuvalu: 'Tuvalu', 图瓦卢: 'Tuvalu',
  vanuatu: 'Vanuatu', 瓦努阿图: 'Vanuatu',
}

/** Detect a country name anywhere in the given text. */
function detectCountry(text: string): string | undefined {
  const lower = text.toLowerCase()
  // Sort aliases by length desc so "united states" wins over "us".
  const aliases = Object.keys(COUNTRY_ALIASES).sort((a, b) => b.length - a.length)
  for (const alias of aliases) {
    // CJK aliases: plain substring match. Latin aliases: word-boundary match.
    const isCjk = /[\u4e00-\u9fff]/.test(alias)
    if (isCjk) {
      if (text.includes(alias)) return COUNTRY_ALIASES[alias]
    } else {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i')
      if (re.test(lower)) return COUNTRY_ALIASES[alias]
    }
  }
  return undefined
}

/**
 * Return the canonical country ONLY when the whole line is essentially just a
 * country name (e.g. "United States", "USA", "美国"). Such a line should feed
 * the country field, never the customer name. Tolerates trailing punctuation
 * and both the dotted ("u.s.") and stripped ("us") forms.
 */
function pureCountry(line: string): string | undefined {
  const raw = line.trim().toLowerCase().replace(/[,.]+$/, '').trim()
  const stripped = raw.replace(/[.,]/g, '').replace(/\s+/g, ' ').trim()
  return COUNTRY_ALIASES[raw] ?? COUNTRY_ALIASES[stripped]
}

function stripLabel(line: string): { key?: keyof ParsedCustomer; value: string } {
  const sepMatch = line.match(/^\s*([^:：]+)[:：]\s*(.*)$/)
  if (!sepMatch) return { value: line.trim() }
  const rawKey = sepMatch[1].trim().toLowerCase()
  const value = sepMatch[2].trim()
  for (const key of Object.keys(LABELS) as (keyof ParsedCustomer)[]) {
    if (LABELS[key].some((alias) => rawKey === alias || rawKey.includes(alias))) {
      return { key, value }
    }
  }
  return { value: line.trim() }
}

/**
 * Parse a blob of pasted customer text into structured fields.
 * Handles both "标签: 值" lines and unlabeled lines via heuristics
 * (email/phone regex, address keyword detection).
 */
export function parseCustomerText(text: string): ParsedCustomer {
  const result: ParsedCustomer = {}
  if (!text?.trim()) return result

  // Support both newlines and common inline separators.
  const lines = text
    .split(/\r?\n|[;；]|\s{2,}|\||、/)
    .map((l) => l.trim())
    .filter(Boolean)

  const leftovers: string[] = []

  for (const line of lines) {
    const { key, value } = stripLabel(line)
    if (key && value && !result[key]) {
      result[key] = value
      continue
    }
    leftovers.push(key ? value || line : line)
  }

  // Pull email/phone from anywhere they still live (labeled value or leftovers).
  const scanPool = [
    result.email ?? '',
    result.phone ?? '',
    ...leftovers,
    text,
  ]
  if (!result.email) {
    for (const s of scanPool) {
      const m = s.match(EMAIL_RE)
      if (m) {
        result.email = m[0]
        break
      }
    }
  }
  if (!result.phone) {
    for (const s of leftovers.concat(text)) {
      // Avoid matching inside an email.
      const withoutEmail = s.replace(EMAIL_RE, ' ')
      const m = withoutEmail.match(PHONE_RE)
      if (m && (m[1].replace(/\D/g, '').length >= 7)) {
        result.phone = m[1].trim()
        break
      }
    }
  }

  // Clean email/phone out of the labeled email/phone fields if they got extra text.
  if (result.email) {
    const m = result.email.match(EMAIL_RE)
    if (m) result.email = m[0]
  }

  // From remaining leftovers, classify each line precisely so that countries and
  // payment methods never leak into the name/company fields.
  const remaining = leftovers.filter((l) => {
    if (result.email && l.includes(result.email)) return false
    if (result.phone && l.includes(result.phone)) return false
    return true
  })

  const addressParts: string[] = []
  const nameCandidates: string[] = []

  for (const l of remaining) {
    const trimmed = l.trim()
    if (!trimmed) continue
    const lower = trimmed.toLowerCase()

    // 1) Payment-method noise (PayPal / Zelle / wire / 支付宝 ...) -> drop.
    if (PAYMENT_HINTS.some((h) => lower.includes(h))) continue

    // 2) A line that is purely a country -> country field only, never the name.
    const pc = pureCountry(trimmed)
    if (pc) {
      if (!result.country) result.country = pc
      continue
    }

    // 3) Address parts: street line, "City, ST [zip]" locality, bare ZIP, or a
    //    line carrying an address hint keyword (covers CJK addresses too).
    if (
      STREET_RE.test(trimmed) ||
      CITY_STATE_RE.test(trimmed) ||
      ZIP_RE.test(trimmed) ||
      ADDRESS_HINTS.some((h) => lower.includes(h))
    ) {
      addressParts.push(trimmed)
      continue
    }

    // 4) Otherwise a candidate for name / company.
    nameCandidates.push(trimmed)
  }

  if (!result.address && addressParts.length) {
    result.address = addressParts.join(', ')
  }
  if (!result.name && nameCandidates[0]) result.name = nameCandidates[0]
  if (!result.company && nameCandidates[1]) result.company = nameCandidates[1]

  // Country: if still unknown, detect from the address first, then the whole text.
  if (!result.country) {
    result.country = detectCountry(result.address ?? '') ?? detectCountry(text)
  } else {
    // Normalize a labeled country value too (e.g. "usa" -> "USA").
    result.country = detectCountry(result.country) ?? result.country
  }

  // Extract postal code from address or raw text into a separate field.
  if (!result.postal_code) {
    const addrOrText = result.address || text
    // US ZIP
    const usZip = addrOrText.match(/\b(\d{5})(-\d{4})?\b/)
    // UK postcode
    const ukPost = addrOrText.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i)
    // Canada postal code
    const caPost = addrOrText.match(/\b([A-Z]\d[A-Z]\s*\d[A-Z]\d)\b/i)
    // Japan postal code
    const jpPost = addrOrText.match(/\b(\d{3}-\d{4})\b/)

    if (usZip) result.postal_code = usZip[0]
    else if (ukPost) result.postal_code = ukPost[1]
    else if (caPost) result.postal_code = caPost[1]
    else if (jpPost) result.postal_code = jpPost[1]
  }

  // Extract city/state from "City, ST" or "City, ST ZIP" pattern.
  if (!result.city) {
    const addrOrText = result.address || text
    const csMatch = addrOrText.match(/([A-Za-z][A-Za-z .'-]+),\s*([A-Za-z]{2})\.?(?:\s+\d{5})?/)
    if (csMatch) {
      result.city = csMatch[1].trim()
      if (!result.state) result.state = csMatch[2].trim()
    }
  }

  return result
}
