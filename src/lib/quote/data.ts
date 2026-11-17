export type CategoryId = 'mask' | 'cotton' | 'oil' | 'cream' | 'eyemask'

/** Form values are kept as loose scalars because each category has its own fields. */
export type QuoteInput = Record<string, string | number>

/** Descending tiers: the first threshold the quantity reaches wins. */
export type DescTier = readonly [min: number, price: number]
/** Ascending tiers: the first threshold the quantity stays under wins. */
export type AscTier = readonly [max: number, price: number]
export type MarginRule = readonly [minExclusive: number, margin: number]
export type TierMeta = readonly [qty: number, label: string, labelEn: string]

export const CATEGORIES: readonly {
  id: CategoryId
  cn: string
  en: string
  code: string
  qtyKey: string
  qtyUnit: string
}[] = [
  { id: 'mask', cn: '面膜', en: 'Sheet Masks', code: 'MASK', qtyKey: 'totalPieces', qtyUnit: '片' },
  { id: 'cotton', cn: '湿敷棉', en: 'Wet Compress Cotton', code: 'COT', qtyKey: 'qty', qtyUnit: '罐/袋' },
  { id: 'oil', cn: '精油 / 精华', en: 'Essential Oils & Serums', code: 'OIL', qtyKey: 'qty', qtyUnit: '瓶' },
  { id: 'cream', cn: '霜 / 乳 / 膏 / 水', en: 'Creams, Lotions & Toners', code: 'CRM', qtyKey: 'qty', qtyUnit: '支/罐' },
  { id: 'eyemask', cn: '眼膜 / 唇膜', en: 'Eye & Lip Masks', code: 'EYE', qtyKey: 'qtyPairs', qtyUnit: '对' },
]

const BASE_FX = 6.4
const BASE_PLATE = 350
// `let` + live bindings: applyQuoteOverrides can swap these at runtime (DB overrides).
export let FX_DEFAULT = BASE_FX
export let PLATE_COLOR_PRICE = BASE_PLATE

export const COMPANY = {
  cn: '佛山京妍生物制品有限公司',
  en: 'Foshan Jingyan Biological Products Co., Ltd.',
}

interface MaskData {
  defaults: QuoteInput
  box: Record<number, DescTier[]>
  laborPerBox: number
  tiers: TierMeta[]
  costs: {
    film: TieredCost
    bag: FoilBagCost
    tray: AscCost
  }
}

const mask: MaskData = {
  defaults: {
    totalPieces: 3000,
    colorBox: '是',
    piecesPerBox: 4,
    innerTray: '否',
    colors: 4,
  },
  box: {
    4: [[5000, 0.72], [2000, 0.8], [1000, 1.3], [0, 2.0]],
    5: [[5000, 0.92], [2000, 1.0], [1000, 1.5], [0, 2.4]],
    10: [[5000, 1.82], [2000, 2.0], [1000, 2.8], [0, 3.5]],
  },
  laborPerBox: 0.8,
  tiers: [
    [3000, '试单打样', 'Pilot order'],
    [5000, '试销测款', 'Market test'],
    [10000, '标准起订 MOQ', 'Standard MOQ'],
    [20000, '常规返单', 'Repeat order'],
    [50000, '大宗采购', 'Bulk purchase'],
    [100000, '战略大客户', 'Strategic key account'],
  ],
  costs: {
    film: { tiers: [[100000, 1.2], [0, 1.33]] },
    bag: { minQty: 10000, minTotal: 3000, tiers: [[100000, 0.25], [50000, 0.28], [0, 0.3]] },
    tray: { tiers: [[1000, 0.2], [Infinity, 0.1]] },
  },
}

interface CottonData {
  defaults: QuoteInput
  jarTiers: DescTier[]
  padPrice: Record<string, number>
  lotion: {
    ready: Record<number, number>
    formula: { base: number; basePads: number; step: number }
  }
  box: AscTier[]
  laborPerBox: number
  tiers: TierMeta[]
  costs: {
    bag: FoilBagCost
    tray: AscCost
    label: SetupCost
    silk: SetupCost
  }
}

const cotton: CottonData = {
  defaults: {
    packForm: '罐装',
    padsPerUnit: 60,
    material: '冰冰棉',
    qty: 5000,
    colorBox: '是',
    innerTray: '是',
    print: '瓶标',
  },
  jarTiers: [[10000, 2.8], [1000, 3.2], [0, 3.6]],
  padPrice: { '无纺布（传统棉）': 0.03, '冰冰棉': 0.06 },
  lotion: {
    ready: { 60: 2.0, 70: 2.05, 100: 2.2 },
    formula: { base: 2.0, basePads: 60, step: 0.2 / 40 },
  },
  box: [[500, 2.0], [1000, 1.5], [2000, 1.15], [5000, 1.0], [Infinity, 0.95]],
  laborPerBox: 0.8,
  tiers: [
    [500, '试单打样', 'Pilot sample'],
    [1000, '试销测款', 'Market test'],
    [3000, '印刷门槛', 'Printing threshold'],
    [5000, '核心推荐 MOQ', 'Core MOQ'],
    [10000, '大宗采购', 'Bulk purchase'],
    [20000, '战略大客户', 'Strategic key account'],
  ],
  costs: {
    bag: { minQty: 10000, minTotal: 3000, tiers: [[100000, 0.25], [50000, 0.28], [0, 0.3]] },
    tray: { tiers: [[1000, 0.2], [Infinity, 0.1]] },
    label: { setupQty: 3000, setupFee: 800, tiers: [[5000, 0.25], [3000, 0.3]] },
    silk: { setupQty: 2500, setupFee: 1000, tiers: [[10000, 0.2], [5000, 0.3], [2500, 0.4]] },
  },
}

interface CartonBand {
  maxCap?: number
  fixed: number
  tiers: AscTier[]
}

interface OilData {
  defaults: QuoteInput
  bottles: Record<string, Record<number, number>>
  bulk: Record<string, number>
  box: { small: CartonBand; mid: CartonBand; large: CartonBand }
  tiers: TierMeta[]
  costs: {
    label: SetupCost
    silk: SetupCost
    tray: AscCost
    labor: { boxed: number; plain: number; decorated: number }
  }
}

const oil: OilData = {
  defaults: {
    category: '精华类',
    bottle: '滴管瓶（玻璃）',
    capacity: 30,
    qty: 3000,
    colorBox: '是',
    innerTray: '是',
    print: '瓶标',
  },
  bottles: {
    '滴管瓶（玻璃）': { 20: 0.91, 30: 0.96, 40: 1.12, 50: 1.2, 60: 1.28 },
    '精油瓶（玻璃）': { 5: 0.35, 10: 0.38, 15: 0.39, 20: 0.4, 30: 0.5, 50: 0.53, 100: 0.68 },
    '滴管瓶（塑料）': {
      5: 0.47, 10: 0.47, 15: 0.48, 20: 0.49, 30: 0.5, 40: 0.54,
      50: 0.55, 60: 0.56, 80: 0.58, 100: 0.6, 120: 0.62,
    },
    '尖嘴瓶（塑料）': {
      30: 0.36, 50: 0.37, 60: 0.4, 80: 0.41, 100: 0.43,
      120: 0.46, 150: 0.5, 180: 0.6, 250: 0.63, 500: 0.92,
    },
    '泵头瓶（塑料）': {
      100: 1.25, 120: 1.26, 150: 1.3, 200: 1.32,
      250: 1.35, 300: 1.38, 400: 1.75, 500: 1.77,
    },
  },
  bulk: { 精油类: 0.035, 精华类: 0.05 },
  box: {
    small: { maxCap: 150, fixed: 650, tiers: [[1000, 1.3], [2000, 1.0], [5000, 0.8], [Infinity, 0.7]] },
    mid: { maxCap: 250, fixed: 750, tiers: [[1000, 1.5], [2000, 1.15], [5000, 1.0], [Infinity, 0.95]] },
    large: { fixed: 900, tiers: [[1000, 1.8], [2000, 1.5], [5000, 1.2], [Infinity, 1.1]] },
  },
  tiers: [
    [500, '试单起步', 'Pilot order'],
    [1000, '小单快反', 'Quick response'],
    [2000, '标准起订', 'Standard order'],
    [3000, '品牌进阶', 'Brand scaling'],
    [5000, '规模定制', 'Volume order'],
    [10000, '战略大单', 'Strategic bulk'],
  ],
  costs: {
    label: { setupQty: 3000, setupFee: 800, tiers: [[5000, 0.24], [3000, 0.25]] },
    silk: { setupQty: 2500, setupFee: 1000, tiers: [[10000, 0.2], [5000, 0.3], [2500, 0.4]] },
    tray: { tiers: [[100, 0.1], [200, 0.15], [Infinity, 0.2]] },
    labor: { boxed: 0.8, plain: 0.1, decorated: 0.3 },
  },
}

interface CreamData {
  defaults: QuoteInput
  bulk: Record<string, { kg: number; perG: number }>
  capacities: number[]
  containers: Record<string, number[]>
  box: { small: CartonBand; mid: CartonBand; large: CartonBand }
  tiers: TierMeta[]
  costs: {
    discount: TieredCost
    label: SetupCost
    silk: SetupCost
    tray: AscCost
    labor: { boxed: number; plain: number }
  }
}

const cream: CreamData = {
  defaults: {
    bulkType: '普通面霜',
    container: '亚克力罐（面霜）',
    capacity: 50,
    qty: 3000,
    colorBox: '是',
    innerTray: '是',
    print: '丝印',
  },
  bulk: {
    普通面霜: { kg: 45, perG: 0.045 },
    '胶囊面霜、眼霜、洗面奶、防晒霜': { kg: 60, perG: 0.06 },
    功效型面霜: { kg: 100, perG: 0.1 },
    '撕拉面膜、牛脂膏、磨砂膏': { kg: 50, perG: 0.05 },
    固体膏类: { kg: 80, perG: 0.08 },
    '爽肤水、凝胶啫喱、身体乳': { kg: 25, perG: 0.025 },
  },
  capacities: [5, 10, 15, 20, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300],
  containers: {
    '亚克力罐（面霜）': [1, 1.3, 1.85, 1.9, 2.85, 3.5, 4.8, 5.5, 6.2, 7, 7.8, 8.5, 9, 10.5, 12],
    '玻璃罐（面霜）': [1, 1.24, 1.36, 1.44, 1.64, 1.8, 2, 2.3, 2.7, 3.26, 3.7, 4.4, 5.6, 7, 8.4],
    'PE塑料罐（磨砂膏、牛脂膏、身体乳）': [0.4, 0.46, 0.5, 0.56, 0.68, 0.8, 0.92, 1.04, 1.16, 1.3, 1.4, 1.48, 1.7, 2, 2.4],
    软管: [1.2, 1.2, 1.26, 1.3, 1.36, 1.44, 1.56, 1.6, 1.8, 2, 2, 2.8, 3.4, 4.2, 5],
    铝管: [1.8, 1.8, 1.89, 1.95, 2.04, 2.16, 2.34, 2.4, 2.7, 3, 3, 4.2, 5.1, 6.3, 7.5],
    '膏体管（唇膏、保湿棒）': [2.88, 2.88, 3.2, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 9, 10],
    'PET塑料瓶（爽肤水）': [0.7, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.17, 1.17, 1.21, 1.26, 1.43, 1.7, 2],
  },
  box: {
    small: { maxCap: 150, fixed: 650, tiers: [[1000, 1.3], [2000, 1.0], [5000, 0.8], [Infinity, 0.7]] },
    mid: { maxCap: 250, fixed: 750, tiers: [[1000, 1.5], [2000, 1.15], [5000, 1.0], [Infinity, 0.95]] },
    large: { fixed: 900, tiers: [[1000, 1.8], [2000, 1.5], [5000, 1.2], [Infinity, 1.1]] },
  },
  tiers: [
    [500, '打样测款', 'Sampling'],
    [1000, '试销起步', 'Trial run'],
    [2000, '经济采购', 'Economy order'],
    [3000, '核心推荐 MOQ', 'Core MOQ'],
    [5000, '规模采购', 'Volume order'],
    [10000, '大宗爆款', 'Bulk bestseller'],
    [20000, '战略集采', 'Strategic sourcing'],
  ],
  costs: {
    discount: { tiers: [[10000, 0.85], [3000, 0.9], [0, 1]] },
    label: { setupQty: 3000, setupFee: 800, tiers: [[5000, 0.24], [3000, 0.25]] },
    silk: { setupQty: 2500, setupFee: 1000, tiers: [[10000, 0.2], [5000, 0.3], [2500, 0.4]] },
    tray: { tiers: [[100, 0.1], [200, 0.15], [Infinity, 0.2]] },
    labor: { boxed: 0.8, plain: 0.4 },
  },
}

export type MembraneKind = 'jar' | 'waterbag' | 'gelbag' | 'silicone'

/** ≥ 数量阶梯成本（第一个达到的门槛生效），如膜片、硅胶膜材。 */
export interface TieredCost {
  tiers: DescTier[]
}
/** ≤ 数量阶梯成本（第一个没超的门槛生效），如内托。 */
export interface AscCost {
  tiers: AscTier[]
}
/** 开机费成本：≤ setupQty 按 setupFee 平摊，超过后走 ≥ 阶梯。 */
export interface SetupCost {
  setupQty: number
  setupFee: number
  tiers: DescTier[]
}
/** 铝箔袋：不足 minQty 个按 minTotal 总价平摊，达到后走 ≥ 阶梯。 */
export interface FoilBagCost {
  minQty: number
  minTotal: number
  tiers: DescTier[]
}

interface EyemaskData {
  defaults: QuoteInput
  membranes: Record<string, { floorTotal: number; floorPrice: number; moq: number; kind: MembraneKind }>
  jars: Record<string, { pairs: number; price: number }>
  bagPrice: {
    water: { minQty: number; minTotal: number; tiers: DescTier[] }
    gel: { minQty: number; minTotal: number; tiers: DescTier[] }
  }
  platePerColor: number
  box: AscTier[]
  laborPerBox: number
  tiers: TierMeta[]
  costs: {
    silicone: TieredCost
    label: SetupCost
    silk: SetupCost
    tray: AscCost
  }
}

const eyemask: EyemaskData = {
  defaults: {
    product: '眼膜',
    material: '罐装膜材',
    jar: '100g常规罐',
    packMode: '6对盒装',
    qtyPairs: 30000,
    colorBox: '是',
    innerTray: '是',
    print: '丝印',
    plateColors: 4,
  },
  membranes: {
    罐装膜材: { floorTotal: 1200, floorPrice: 0.08, moq: 15000, kind: 'jar' },
    '片装水凝胶（吸塑）': { floorTotal: 0, floorPrice: 0.3, moq: 50000, kind: 'waterbag' },
    '凝胶眼膜（贴布-定制Logo）': { floorTotal: 27500, floorPrice: 0.55, moq: 50000, kind: 'gelbag' },
    '凝胶眼膜（贴布-不定制Logo）': { floorTotal: 3500, floorPrice: 0.7, moq: 5000, kind: 'gelbag' },
    '硅胶眼膜（吸盘）': { floorTotal: 2000, floorPrice: 2.0, moq: 1000, kind: 'silicone' },
  },
  jars: {
    '50g常规罐': { pairs: 15, price: 1.3 },
    '100g常规罐': { pairs: 30, price: 1.63 },
    '120g常规罐': { pairs: 40, price: 1.92 },
    '36对高档旋转罐': { pairs: 36, price: 8.5 },
    '无需包材（客户自备）': { pairs: 36, price: 0 },
  },
  bagPrice: {
    water: { minQty: 10000, minTotal: 2000, tiers: [[50000, 0.17], [10000, 0.2]] },
    gel: { minQty: 10000, minTotal: 2000, tiers: [[30000, 0.1], [10000, 0.2]] },
  },
  platePerColor: 300,
  box: [[500, 2.0], [1000, 1.5], [2000, 1.15], [5000, 1.0], [Infinity, 0.95]],
  laborPerBox: 0.5,
  tiers: [
    [3000, '试单起步', 'Pilot order'],
    [6000, '小单快反', 'Quick response'],
    [12000, '标准起订', 'Standard order'],
    [30000, '品牌进阶', 'Brand scaling'],
    [60000, '规模定制', 'Volume order'],
    [120000, '战略大单', 'Strategic bulk'],
  ],
  costs: {
    silicone: { tiers: [[10000, 1.74], [0, 2.0]] },
    label: { setupQty: 3000, setupFee: 800, tiers: [[5000, 0.25], [3000, 0.30]] },
    silk: { setupQty: 2500, setupFee: 1000, tiers: [[10000, 0.2], [5000, 0.3], [2500, 0.4]] },
    tray: { tiers: [[1000, 0.2], [Infinity, 0.1]] },
  },
}

export const DATA = { mask, cotton, oil, cream, eyemask }

export type QuoteData = typeof DATA

/** Pristine code defaults; applyQuoteOverrides always merges from a fresh clone of this. */
const BASE_DATA: QuoteData = structuredClone(DATA)

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep-merge: plain objects merge recursively, arrays/scalars replace wholesale. */
export function deepMerge<T>(base: T, overrides: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(overrides)) {
    return overrides === undefined ? base : (overrides as T)
  }
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) continue
    out[k] = k in out ? deepMerge(out[k], v) : v
  }
  return out as T
}

export interface QuoteGlobals {
  FX_DEFAULT?: number
  PLATE_COLOR_PRICE?: number
}

/**
 * jsonb/JSON round-trip turns Infinity (open end of an ascending tier) into
 * null; restore it so engine tier lookups keep working on DB-loaded overrides.
 */
export function reviveInfTiers(v: unknown): unknown {
  if (Array.isArray(v)) {
    if (v.length === 2 && v[0] === null && typeof v[1] === 'number') return [Infinity, v[1]]
    return v.map(reviveInfTiers)
  }
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = reviveInfTiers(x)
    return out
  }
  return v
}

export type QuoteOverrides = Partial<Record<CategoryId, unknown>> & QuoteGlobals

/**
 * Swap the module-level DATA / globals to DB-stored overrides so engine, form and
 * text lookups all pick them up. Pass null (or omit a category) to restore code defaults.
 */
export function applyQuoteOverrides(overrides: QuoteOverrides | null): void {
  const src = overrides ?? {}
  for (const c of CATEGORIES) {
    const o = src[c.id]
    const base = structuredClone(BASE_DATA[c.id])
    ;(DATA as Record<string, unknown>)[c.id] = o === undefined ? base : deepMerge(base, o)
  }
  const fx = Number(src.FX_DEFAULT)
  FX_DEFAULT = Number.isFinite(fx) && fx > 0 ? fx : BASE_FX
  const plate = Number(src.PLATE_COLOR_PRICE)
  PLATE_COLOR_PRICE = Number.isFinite(plate) && plate >= 0 ? plate : BASE_PLATE
}

export function quoteDefaults(): QuoteOverrides {
  return {
    FX_DEFAULT: BASE_FX,
    PLATE_COLOR_PRICE: BASE_PLATE,
    mask: structuredClone(BASE_DATA.mask),
    cotton: structuredClone(BASE_DATA.cotton),
    oil: structuredClone(BASE_DATA.oil),
    cream: structuredClone(BASE_DATA.cream),
    eyemask: structuredClone(BASE_DATA.eyemask),
  }
}

export function defaultsFor(categoryId: CategoryId): QuoteInput {
  return { ...DATA[categoryId].defaults }
}

export function tiersFor(categoryId: CategoryId): TierMeta[] {
  return DATA[categoryId].tiers
}
