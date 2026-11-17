import {
  CATEGORIES,
  DATA,
  FX_DEFAULT,
  PLATE_COLOR_PRICE,
  type AscTier,
  type CategoryId,
  type DescTier,
  type QuoteInput,
} from './data'

export interface QuoteCost {
  key: string
  name: string
  nameEn: string
  basis: string
  total: number
  perUnit: number
  perMini: number
  share: number
}

export interface QuoteTier {
  qty: number
  label: string
  labelEn: string
  packs: number
  margin: number
  unitCost: number
  unitPrice: number
  unitFob: number
  miniPrice: number
  totalUSD: number
}

export interface QuoteResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  notes: string[]
  description: string
  specs: [string, string][]
  fx: number
  margin: number
  autoMargin: number
  marginManual: boolean
  qty: number
  orderQty: number
  packs: number
  unitLabel: string
  unitEn: string
  packLabel: string
  packPerUnit: number
  miniLabel: string
  miniPerUnit: number
  billedMini: number
  costTotal: number
  unitCost: number
  unitPrice: number
  unitFob: number
  packCost: number
  packPrice: number
  packFob: number
  miniCost: number
  miniPrice: number
  miniFob: number
  revenueRMB: number
  revenueUSD: number
  profitRMB: number
  profitUSD: number
  costs: QuoteCost[]
  tiers: QuoteTier[]
  categoryId?: CategoryId
}

export interface ComputeOptions {
  fx?: number | null
  margin?: number | null
}

export interface EyePack {
  perPack: number
  jarPrice?: number
  isJar: boolean
  kind: 'jar' | 'waterbag' | 'gelbag' | 'silicone'
  boxed: boolean
  packName: string
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : fallback
}

function ceil(n: number) {
  return Math.ceil(n - 1e-9)
}

function pickDesc(tiers: readonly DescTier[], q: number): number {
  for (const [min, price] of tiers) if (q >= min) return price
  return tiers[tiers.length - 1][1]
}

function pickAsc(rules: readonly AscTier[], q: number): number {
  for (const [max, price] of rules) if (q <= max) return price
  return rules[rules.length - 1][1]
}

function boxPriceFor(cap: number, qty: number, cfg: { small: anyBand; mid: anyBand; large: anyBand }) {
  const band = cap <= cfg.small.maxCap! ? cfg.small : cap <= cfg.mid.maxCap! ? cfg.mid : cfg.large
  if (qty <= 500) return band.fixed / qty
  return pickAsc(band.tiers, qty)
}

interface anyBand {
  maxCap?: number
  fixed: number
  tiers: readonly AscTier[]
}

function failed(errors: string[], fx = FX_DEFAULT): QuoteResult {
  return {
    ok: false,
    errors,
    warnings: [],
    notes: [],
    description: '',
    specs: [],
    fx,
    margin: 0,
    autoMargin: 0,
    marginManual: false,
    qty: 0,
    orderQty: 0,
    packs: 0,
    unitLabel: '件',
    unitEn: 'units',
    packLabel: '件',
    packPerUnit: 1,
    miniLabel: '件',
    miniPerUnit: 1,
    billedMini: 0,
    costTotal: 0,
    unitCost: 0,
    unitPrice: 0,
    unitFob: 0,
    packCost: 0,
    packPrice: 0,
    packFob: 0,
    miniCost: 0,
    miniPrice: 0,
    miniFob: 0,
    revenueRMB: 0,
    revenueUSD: 0,
    profitRMB: 0,
    profitUSD: 0,
    costs: [],
    tiers: [],
  }
}

interface Draft {
  qty: number
  packs: number
  unitLabel: string
  unitEn: string
  packLabel: string
  packPerUnit?: number
  miniLabel: string
  miniPerUnit: number
  rows: { key: string; name: string; nameEn?: string; basis: string; total: number }[]
  fx: number
  margin: number
  autoMargin: number
  marginManual: boolean
  errors: string[]
  warnings: string[]
  notes?: string[]
  orderQty?: number
  description: string
  specs: [string, string][]
}

function finalize(o: Draft): QuoteResult {
  const qty = o.qty
  const packPerUnit = o.packPerUnit ?? 1
  const totalCost = o.rows.reduce((s, r) => s + r.total, 0)
  const unitCost = totalCost / qty
  const unitPrice = unitCost / (1 - o.margin)
  const unitFob = unitPrice / o.fx
  const billedMini = qty * o.miniPerUnit
  const costs = o.rows.map((r) => ({
    key: r.key,
    name: r.name,
    nameEn: r.nameEn ?? '',
    basis: r.basis,
    total: r.total,
    perUnit: r.total / qty,
    perMini: r.total / billedMini,
    share: totalCost ? r.total / totalCost : 0,
  }))
  return {
    ok: o.errors.length === 0,
    errors: o.errors,
    warnings: o.warnings,
    notes: o.notes ?? [],
    description: o.description,
    specs: o.specs,
    fx: o.fx,
    margin: o.margin,
    autoMargin: o.autoMargin,
    marginManual: o.marginManual,
    qty,
    orderQty: o.orderQty ?? qty,
    packs: o.packs,
    unitLabel: o.unitLabel,
    unitEn: o.unitEn,
    packLabel: o.packLabel,
    packPerUnit,
    miniLabel: o.miniLabel,
    miniPerUnit: o.miniPerUnit,
    billedMini,
    costTotal: totalCost,
    unitCost,
    unitPrice,
    unitFob,
    packCost: unitCost * packPerUnit,
    packPrice: unitPrice * packPerUnit,
    packFob: unitFob * packPerUnit,
    miniCost: totalCost / billedMini,
    miniPrice: unitPrice / o.miniPerUnit,
    miniFob: unitFob / o.miniPerUnit,
    revenueRMB: unitPrice * qty,
    revenueUSD: (unitPrice * qty) / o.fx,
    profitRMB: (unitPrice - unitCost) * qty,
    profitUSD: ((unitPrice - unitCost) * qty) / o.fx,
    costs,
    tiers: [],
  }
}

// ------------------------------------------------------------------ mask
function maskAt(input: QuoteInput, qty: number, fx: number, marginOverride: number | null) {
  const errors: string[] = []
  const warnings: string[] = []
  const notes: string[] = []
  if (!(qty > 0)) errors.push('订购数量必须大于 0')
  qty = Math.max(1, Math.floor(qty))
  const boxed = input.colorBox !== '否'
  const ppb = boxed ? Math.max(1, Math.floor(num(input.piecesPerBox, 4))) : 1
  const boxes = boxed ? ceil(qty / ppb) : 0
  const autoMargin = qty > 20000 ? 0.15 : qty > 10000 ? 0.25 : 0.35
  const margin = marginOverride == null ? autoMargin : marginOverride
  const film = qty >= 100000 ? 1.2 : 1.33
  const bag = qty < 10000 ? 3000 / qty : qty >= 100000 ? 0.25 : qty >= 50000 ? 0.28 : 0.3
  const boxUnit = boxed ? pickDesc(DATA.mask.box[ppb] || DATA.mask.box[10], boxes) : 0
  const trayUnit = boxed && input.innerTray === '是' ? (boxes > 1000 ? 0.1 : 0.2) : 0
  const laborUnit = boxed ? DATA.mask.laborPerBox : 0
  const colors = num(input.colors, 0)
  const plateTotal = colors * PLATE_COLOR_PRICE
  const rows = [
    { key: 'film', name: '膜片成本', nameEn: 'Mask sheet', basis: `面膜料体 + 天丝/蚕丝基布 + 无菌灌装 · ${film.toFixed(2)} 元/片`, total: film * qty },
    { key: 'bag', name: '铝箔袋', nameEn: 'Foil pouch', basis: qty < 10000 ? '未达 1 万个，按 ¥3,000 总价分摊' : `阶梯价 ${bag.toFixed(2)} 元/个（${qty >= 100000 ? '≥10万' : qty >= 50000 ? '5万–10万' : '1万–5万'}片）`, total: bag * qty },
    { key: 'box', name: '彩盒', nameEn: 'Color box', basis: boxed ? `${boxes} 盒 × ${boxUnit.toFixed(2)} 元/盒（${ppb}片装）` : '片装无彩盒', total: boxUnit * boxes },
    { key: 'tray', name: '吸塑内托', nameEn: 'Inner tray', basis: boxed && input.innerTray === '是' ? `${boxes > 1000 ? '>1000' : '≤1000'} 盒 · ${trayUnit.toFixed(2)} 元/盒` : '未添加内托', total: trayUnit * boxes },
    { key: 'labor', name: '装盒人工', nameEn: 'Assembly labor', basis: boxed ? `${DATA.mask.laborPerBox.toFixed(2)} 元/盒 × ${boxes} 盒` : '片装免人工装配', total: laborUnit * boxes },
    { key: 'plate', name: '印刷色版费', nameEn: 'Plate fee', basis: `${colors} 色 × ${PLATE_COLOR_PRICE} 元/色，按总量平摊`, total: plateTotal },
  ]
  if (qty < 10000) warnings.push('铝箔袋起订 10,000 个：本单不足 1 万片，袋子按 1 万个总价 ¥3,000 平摊。')
  if (boxed && qty % ppb !== 0) warnings.push(`总片数不是 ${ppb} 的整数倍，按 ${boxes} 盒整盒计费。`)
  if (!boxed) notes.push('已选择不配彩盒：彩盒、内托与 0.80 元/盒装盒人工自动不计。')
  if (qty >= 100000) notes.push('膜片与袋子均已进入 10 万片极限阶梯，适合品牌大单。')

  return finalize({
    qty,
    packs: boxes,
    unitLabel: '片',
    unitEn: 'pcs',
    packLabel: '盒',
    packPerUnit: ppb,
    miniLabel: boxed ? '盒' : '片',
    miniPerUnit: boxed ? 1 / ppb : 1,
    rows,
    fx,
    margin,
    autoMargin,
    marginManual: marginOverride != null,
    errors,
    warnings,
    notes,
    description: `${boxed ? ppb + '片盒装' : '单片袋装'} · 面膜`,
    specs: [
      ['包装形式', boxed ? `配彩盒 · ${ppb} 片/盒` : '不配彩盒（单片袋装）'],
      ['定制总量', `${qty.toLocaleString('en-US')} 片${boxed ? `（${boxes.toLocaleString('en-US')} 盒）` : ''}`],
      ['内托', boxed ? String(input.innerTray) : '不适用'],
      ['印刷', `${colors} 色 · 版费 ¥${plateTotal.toLocaleString('en-US')}`],
    ],
  })
}

function computeMask(input: QuoteInput, fx: number, marginOverride: number | null): QuoteResult {
  const qty = Math.max(1, Math.floor(num(input.totalPieces, 1)))
  const base = maskAt(input, qty, fx, marginOverride)
  base.tiers = DATA.mask.tiers.map(([q, label, labelEn]) => {
    const r = maskAt(input, q, fx, null)
    return { qty: q, label, labelEn, packs: r.packs, margin: r.autoMargin, unitCost: r.unitCost, unitPrice: r.unitPrice, unitFob: r.unitFob, miniPrice: r.miniPrice, totalUSD: r.revenueUSD }
  })
  return base
}

// ---------------------------------------------------------------- cotton
function cottonAt(input: QuoteInput, qty: number, fx: number, marginOverride: number | null) {
  const errors: string[] = []
  const warnings: string[] = []
  const notes: string[] = []
  if (!(qty > 0)) errors.push('订购数量必须大于 0')
  qty = Math.max(1, Math.floor(qty))
  const form = input.packForm
  const pads = num(input.padsPerUnit, 60)
  const isIce = String(input.material).indexOf('冰冰') >= 0
  const C = DATA.cotton
  const padPrice = isIce ? C.padPrice['冰冰棉'] : C.padPrice['无纺布（传统棉）']
  const autoMargin = isIce
    ? qty >= 10000 ? 0.15 : qty >= 5000 ? 0.2 : 0.3
    : qty >= 10000 ? 0.15 : qty >= 5000 ? 0.2 : qty >= 2000 ? 0.25 : 0.3
  const margin = marginOverride == null ? autoMargin : marginOverride
  const jar = form === '罐装' ? pickDesc(C.jarTiers, qty) : 0
  const bag = form === '袋装' ? (qty < 10000 ? 3000 / qty : qty >= 100000 ? 0.25 : qty >= 50000 ? 0.28 : 0.3) : 0
  const lotion = C.lotion.ready[pads] ?? C.lotion.formula.base + (pads - C.lotion.formula.basePads) * C.lotion.formula.step
  const print = form === '罐装' ? input.print : '无'
  let label = 0
  let silk = 0
  if (print === '瓶标') label = qty <= 3000 ? 800 / qty : qty >= 5000 ? 0.25 : 0.3
  if (print === '丝印') silk = qty <= 2500 ? 1000 / qty : qty <= 4999 ? 0.4 : qty <= 9999 ? 0.3 : 0.2
  const boxed = input.colorBox === '是'
  const boxUnit = boxed ? pickAsc(C.box, qty) : 0
  const trayUnit = boxed && input.innerTray === '是' ? (qty <= 1000 ? 0.2 : 0.1) : 0
  const laborUnit = boxed ? C.laborPerBox : 0
  const rows = [
    { key: 'jar', name: '密封罐', nameEn: 'Jar', basis: form === '罐装' ? `罐装 ${qty >= 10000 ? '≥1万' : qty >= 1000 ? '1千–1万' : '500–999'} 件 · ${jar.toFixed(2)} 元/个` : '袋装不需要罐子', total: jar * qty },
    { key: 'bag', name: '铝箔袋', nameEn: 'Foil pouch', basis: form === '袋装' ? (qty < 10000 ? '不足 1 万个，按 ¥3,000 总价分摊' : `阶梯价 ${bag.toFixed(2)} 元/个`) : '罐装不需要袋子', total: bag * qty },
    { key: 'pad', name: '棉片基布', nameEn: 'Cotton pads', basis: `${padPrice.toFixed(2)} 元/片 × ${pads} 片`, total: padPrice * pads * qty },
    { key: 'lotion', name: '精华液料体', nameEn: 'Lotion', basis: `${pads} 片配 ${pads === 60 ? 110 : pads === 70 ? 120 : 140}ml · ${lotion.toFixed(2)} 元/件`, total: lotion * qty },
    { key: 'label', name: '瓶标', nameEn: 'Label', basis: print === '瓶标' ? (qty <= 3000 ? '≤3000 瓶固定 ¥800 平摊' : qty >= 5000 ? '≥5000 瓶 0.25 元/张' : '3001–4999 瓶 0.30 元/张') : '未选择瓶标', total: label * qty },
    { key: 'silk', name: '丝印', nameEn: 'Silkscreen', basis: print === '丝印' ? (qty <= 2500 ? '≤2500 瓶固定 ¥1,000 平摊' : qty <= 4999 ? '2501–4999 瓶 0.40 元/个' : qty <= 9999 ? '5000–9999 瓶 0.30 元/个' : '≥10000 瓶 0.20 元/个') : '未选择丝印', total: silk * qty },
    { key: 'box', name: '外彩盒', nameEn: 'Color box', basis: boxed ? `${qty.toLocaleString('en-US')} 盒 · ${boxUnit.toFixed(2)} 元/盒` : '未选择彩盒', total: boxUnit * qty },
    { key: 'tray', name: '吸塑内托', nameEn: 'Inner tray', basis: boxed && input.innerTray === '是' ? `${qty <= 1000 ? '≤1000' : '>1000'} 个 · ${trayUnit.toFixed(2)} 元/个` : '未添加内托', total: trayUnit * qty },
    { key: 'labor', name: '装盒人工', nameEn: 'Assembly labor', basis: boxed ? '0.80 元/盒' : '袋装/裸罐无装盒人工', total: laborUnit * qty },
  ]
  if (form === '袋装' && qty < 10000) warnings.push('铝箔袋起订 10,000 个：不足 1 万袋按 1 万个总价 ¥3,000 平摊。')
  if (form === '罐装' && qty < 500) warnings.push('密封罐 500 个起订，低于起订量仍按起订价核算。')
  if (form === '袋装') notes.push('袋装自带专版彩色印刷，瓶标/丝印均为 0 元；每袋 1 件，无装盒人工。')
  if (input.material === '冰冰棉') notes.push('冰冰棉亲肤锁水，基布 0.06 元/片，适合中高端定位。')

  return finalize({
    qty,
    packs: qty,
    unitLabel: form === '罐装' ? '罐' : '袋',
    unitEn: 'units',
    packLabel: '件',
    packPerUnit: 1,
    miniLabel: '片',
    miniPerUnit: pads,
    rows,
    fx,
    margin,
    autoMargin,
    marginManual: marginOverride != null,
    errors,
    warnings,
    notes,
    description: `${form} · ${pads}片 · ${input.material}`,
    specs: [
      ['包装形态', String(form)],
      ['每件片数', `${pads} 片`],
      ['基布材质', String(input.material)],
      ['彩盒 / 内托', `${input.colorBox} / ${boxed ? input.innerTray : '不适用'}`],
      ['印刷工艺', form === '袋装' ? '袋装自带专版印刷' : String(input.print)],
    ],
  })
}

function computeCotton(input: QuoteInput, fx: number, marginOverride: number | null): QuoteResult {
  const qty = Math.max(1, Math.floor(num(input.qty, 1)))
  const base = cottonAt(input, qty, fx, marginOverride)
  base.tiers = DATA.cotton.tiers.map(([q, label, labelEn]) => {
    const r = cottonAt(input, q, fx, null)
    return { qty: q, label, labelEn, packs: r.packs, margin: r.autoMargin, unitCost: r.unitCost, unitPrice: r.unitPrice, unitFob: r.unitFob, miniPrice: r.miniPrice, totalUSD: r.revenueUSD }
  })
  return base
}

// ------------------------------------------------------------------- oil
function oilAt(input: QuoteInput, qty: number, fx: number, marginOverride: number | null) {
  const errors: string[] = []
  const warnings: string[] = []
  const notes: string[] = []
  if (!(qty > 0)) errors.push('订购数量必须大于 0')
  qty = Math.max(1, Math.floor(qty))
  const cap = num(input.capacity, 0)
  const O = DATA.oil
  const table = O.bottles[String(input.bottle)] || {}
  const bottle = table[cap]
  if (bottle == null) errors.push(`参数字典中暂无「${input.bottle} · ${cap}ml」的官方核定瓶价，请更换瓶型或容量。`)
  const autoMargin = qty > 5000 ? 0.23 : qty > 2000 ? 0.35 : qty > 500 ? 0.47 : 0.53
  const margin = marginOverride == null ? autoMargin : marginOverride
  const bulkRate = O.bulk[String(input.category)] || O.bulk['精华类']
  const bulk = cap * bulkRate
  const boxed = input.colorBox === '是'
  const boxUnit = boxed ? boxPriceFor(cap, qty, O.box) : 0
  const print = input.print
  const label = print === '瓶标' ? (qty <= 3000 ? 800 / qty : qty >= 5000 ? 0.24 : 0.25) : 0
  const silk = print === '丝印' ? (qty <= 2500 ? 1000 / qty : qty <= 4999 ? 0.4 : qty <= 9999 ? 0.3 : 0.2) : 0
  const trayUnit = boxed && input.innerTray === '是' ? (cap <= 100 ? 0.1 : cap <= 200 ? 0.15 : 0.2) : 0
  const laborUnit = boxed ? 0.8 : print === '无' ? 0.1 : 0.3
  const rows = [
    { key: 'bottle', name: '瓶身容器', nameEn: 'Bottle', basis: `${input.bottle} · ${cap}ml · 官方核定 ${(bottle || 0).toFixed(2)} 元/套`, total: (bottle || 0) * qty },
    { key: 'bulk', name: '原液料体', nameEn: 'Bulk liquid', basis: `${input.category} · ${(bulkRate * 1000).toFixed(0)} 元/升 = ${bulkRate.toFixed(3)} 元/ml × ${cap}ml`, total: bulk * qty },
    { key: 'box', name: '外彩盒', nameEn: 'Color box', basis: boxed ? `${cap <= 150 ? '≤150ml' : cap <= 250 ? '151–250ml' : '>250ml'} · ${qty <= 500 ? '≤500 盒固定费平摊' : boxUnit.toFixed(2) + ' 元/盒'}（${qty.toLocaleString('en-US')} 盒）` : '未选择彩盒', total: boxUnit * qty },
    { key: 'label', name: '瓶标', nameEn: 'Label', basis: print === '瓶标' ? (qty <= 3000 ? '≤3000 瓶固定 ¥800 平摊' : qty >= 5000 ? '≥5000 瓶 0.24 元/张' : '3001–4999 瓶 0.25 元/张') : '未选择瓶标', total: label * qty },
    { key: 'silk', name: '丝印', nameEn: 'Silkscreen', basis: print === '丝印' ? (qty <= 2500 ? '≤2500 瓶固定 ¥1,000 平摊' : qty <= 4999 ? '2501–4999 瓶 0.40 元/个' : qty <= 9999 ? '5000–9999 瓶 0.30 元/个' : '≥10000 瓶 0.20 元/个') : '未选择丝印', total: silk * qty },
    { key: 'tray', name: '防护内托', nameEn: 'Inner tray', basis: boxed && input.innerTray === '是' ? `${cap <= 100 ? '≤100ml' : cap <= 200 ? '101–200ml' : '>200ml'} · ${trayUnit.toFixed(2)} 元/个` : '未添加内托', total: trayUnit * qty },
    { key: 'labor', name: '装配人工', nameEn: 'Assembly labor', basis: boxed ? '配彩盒全工序 0.80 元/瓶' : print === '无' ? '裸瓶简装 0.10 元/瓶' : '裸瓶印刷装配 0.30 元/瓶', total: laborUnit * qty },
  ]
  if (qty < 500) warnings.push('低于 500 瓶试单门槛，按小单阶梯核算。')
  if (print === '瓶标' && qty <= 3000) notes.push('瓶标开机费 ¥800 平摊；超过 3,000 瓶改按 0.25 元/张计。')
  if (print === '丝印' && qty <= 2500) notes.push('丝印开机费 ¥1,000 平摊；超过 2,500 瓶进入 0.40 元档。')
  if (qty > 5000) notes.push('已跨入 >5,000 瓶战略阶梯，料体与包材边际成本最低。')

  return finalize({
    qty,
    packs: qty,
    unitLabel: '瓶',
    unitEn: 'bottles',
    packLabel: '瓶',
    packPerUnit: 1,
    miniLabel: 'ml',
    miniPerUnit: cap || 1,
    rows,
    fx,
    margin,
    autoMargin,
    marginManual: marginOverride != null,
    errors,
    warnings,
    notes,
    description: `${input.category} · ${input.bottle} · ${cap}ml`,
    specs: [
      ['产品品类', String(input.category)],
      ['瓶型 / 容量', `${input.bottle} · ${cap}ml`],
      ['印刷工艺', String(input.print)],
      ['彩盒 / 内托', `${input.colorBox} / ${boxed ? input.innerTray : '不适用'}`],
      ['折合料体', `${((qty * cap) / 1000).toFixed(1)} 升`],
    ],
  })
}

function computeOil(input: QuoteInput, fx: number, marginOverride: number | null): QuoteResult {
  const qty = Math.max(1, Math.floor(num(input.qty, 1)))
  const base = oilAt(input, qty, fx, marginOverride)
  base.tiers = DATA.oil.tiers.map(([q, label, labelEn]) => {
    const r = oilAt(input, q, fx, null)
    return { qty: q, label, labelEn, packs: r.packs, margin: r.autoMargin, unitCost: r.unitCost, unitPrice: r.unitPrice, unitFob: r.unitFob, miniPrice: r.miniPrice, totalUSD: r.revenueUSD }
  })
  return base
}

// ----------------------------------------------------------------- cream
function creamAt(input: QuoteInput, qty: number, fx: number, marginOverride: number | null) {
  const errors: string[] = []
  const warnings: string[] = []
  const notes: string[] = []
  if (!(qty > 0)) errors.push('订购数量必须大于 0')
  qty = Math.max(1, Math.floor(qty))
  const cap = num(input.capacity, 0)
  const C = DATA.cream
  const bulkCfg = C.bulk[String(input.bulkType)]
  const arr = C.containers[String(input.container)]
  const idx = C.capacities.indexOf(cap)
  if (!arr) errors.push(`参数字典中暂无「${input.container}」的核定价格。`)
  if (!bulkCfg) errors.push(`参数字典中暂无「${input.bulkType}」的料体基准价。`)
  if (idx < 0) errors.push(`容量 ${cap}ml/g 不在官方规格表内（5–300ml/g）。`)
  const bottle = arr && idx >= 0 ? arr[idx] : 0
  const discount = qty >= 10000 ? 0.85 : qty >= 3000 ? 0.9 : 1
  const autoMargin = qty >= 10000 ? 0.16 : qty >= 5000 ? 0.2 : qty >= 2000 ? 0.3 : 0.35
  const margin = marginOverride == null ? autoMargin : marginOverride
  const perG = bulkCfg ? bulkCfg.perG : 0
  const bulk = cap * perG
  const boxed = input.colorBox === '是'
  const boxUnit = boxed ? boxPriceFor(cap, qty, C.box) : 0
  const print = input.print
  const label = print === '瓶标' ? (qty <= 3000 ? 800 / qty : qty <= 4999 ? 0.25 : 0.24) : 0
  const silk = print === '丝印' ? (qty <= 2500 ? 1000 / qty : qty <= 4999 ? 0.4 : qty <= 9999 ? 0.3 : 0.2) : 0
  const trayUnit = boxed && input.innerTray === '是' ? (cap <= 100 ? 0.1 : cap <= 200 ? 0.15 : 0.2) : 0
  const laborUnit = boxed ? 0.8 : 0.4
  const rows = [
    { key: 'container', name: '包装容器', nameEn: 'Container', basis: `${input.container} · ${cap}ml/g · 基准 ${bottle.toFixed(2)} 元 × ${discount === 1 ? '无折扣' : discount === 0.9 ? '9折' : '85折'}`, total: bottle * discount * qty },
    { key: 'bulk', name: '料体', nameEn: 'Bulk formula', basis: `${input.bulkType} · ${bulkCfg ? bulkCfg.kg : 0} 元/kg = ${perG.toFixed(3)} 元/g × ${cap}`, total: bulk * qty },
    { key: 'box', name: '外彩盒', nameEn: 'Color box', basis: boxed ? `${cap <= 150 ? '≤150ml' : cap <= 250 ? '151–250ml' : '>250ml'} · ${qty <= 500 ? '≤500 盒固定费平摊' : boxUnit.toFixed(2) + ' 元/盒'}` : '未选择彩盒', total: boxUnit * qty },
    { key: 'label', name: '瓶标', nameEn: 'Label', basis: print === '瓶标' ? (qty <= 3000 ? '≤3000 瓶固定 ¥800 平摊' : qty <= 4999 ? '3001–4999 瓶 0.25 元/张' : '≥5000 瓶 0.24 元/张') : '未选择瓶标', total: label * qty },
    { key: 'silk', name: '丝印', nameEn: 'Silkscreen', basis: print === '丝印' ? (qty <= 2500 ? '≤2500 瓶固定 ¥1,000 平摊' : qty <= 4999 ? '2501–4999 瓶 0.40 元/个' : qty <= 9999 ? '5000–9999 瓶 0.30 元/个' : '≥10000 瓶 0.20 元/个') : '未选择丝印', total: silk * qty },
    { key: 'tray', name: '彩盒内托', nameEn: 'Inner tray', basis: boxed && input.innerTray === '是' ? `${cap <= 100 ? '≤100ml' : cap <= 200 ? '101–200ml' : '>200ml'} · ${trayUnit.toFixed(2)} 元/个` : '未添加内托', total: trayUnit * qty },
    { key: 'labor', name: '灌装组装人工', nameEn: 'Assembly labor', basis: boxed ? '配彩盒 0.80 元/盒' : '裸瓶 0.40 元/瓶', total: laborUnit * qty },
  ]
  if (qty < 500) warnings.push('低于 500 支试单门槛，按小单阶梯核算。')
  if (qty >= 3000 && qty < 10000) notes.push('包材已享 9 折（×0.90），3,000 支是核心推荐起订档。')
  if (qty >= 10000) notes.push('包材已享 85 折（×0.85），丝印 0.20 元、彩盒 0.70 元，均进入底价档。')
  if (print === '瓶标' && qty <= 3000) notes.push('瓶标开机费 ¥800 平摊，小单优先推荐瓶标。')
  if (print === '丝印' && qty <= 2500) notes.push('丝印开机费 ¥1,000 平摊；大单切换丝印更划算。')

  return finalize({
    qty,
    packs: qty,
    unitLabel: '支/罐',
    unitEn: 'units',
    packLabel: '支/罐',
    packPerUnit: 1,
    miniLabel: 'g/ml',
    miniPerUnit: cap || 1,
    rows,
    fx,
    margin,
    autoMargin,
    marginManual: marginOverride != null,
    errors,
    warnings,
    notes,
    description: `${input.bulkType} · ${input.container} · ${cap}ml/g`,
    specs: [
      ['料体品类', String(input.bulkType)],
      ['器型 / 容量', `${input.container} · ${cap}ml/g`],
      ['印刷工艺', String(input.print)],
      ['彩盒 / 内托', `${input.colorBox} / ${boxed ? input.innerTray : '不适用'}`],
      ['包材折扣', discount === 1 ? '标准价' : discount === 0.9 ? '9 折' : '85 折'],
    ],
  })
}

function computeCream(input: QuoteInput, fx: number, marginOverride: number | null): QuoteResult {
  const qty = Math.max(1, Math.floor(num(input.qty, 1)))
  const base = creamAt(input, qty, fx, marginOverride)
  base.tiers = DATA.cream.tiers.map(([q, label, labelEn]) => {
    const r = creamAt(input, q, fx, null)
    return { qty: q, label, labelEn, packs: r.packs, margin: r.autoMargin, unitCost: r.unitCost, unitPrice: r.unitPrice, unitFob: r.unitFob, miniPrice: r.miniPrice, totalUSD: r.revenueUSD }
  })
  return base
}

// --------------------------------------------------------------- eye mask
export function eyePackOf(input: QuoteInput): EyePack | null {
  const E = DATA.eyemask
  const m = E.membranes[String(input.material)]
  if (!m) return null
  if (m.kind === 'jar') {
    const jar = E.jars[String(input.jar)] || E.jars['100g常规罐']
    return { perPack: jar.pairs, jarPrice: jar.price, isJar: true, kind: 'jar', boxed: input.colorBox === '是', packName: String(input.jar) }
  }
  const boxed = input.packMode !== '单袋散装'
  return { perPack: boxed ? 6 : 1, isJar: false, kind: m.kind, boxed, packName: boxed ? '6对彩盒装' : '单袋散装' }
}

function eyeAt(input: QuoteInput, pairs: number, fx: number, marginOverride: number | null) {
  const errors: string[] = []
  const warnings: string[] = []
  const notes: string[] = []
  if (!(pairs > 0)) errors.push('订购数量必须大于 0')
  pairs = Math.max(1, Math.floor(pairs))
  const E = DATA.eyemask
  const m = E.membranes[String(input.material)]
  const pack = eyePackOf(input)
  if (!m || !pack) {
    errors.push('膜材类型无效。')
    return finalize({
      qty: 1, packs: 0, unitLabel: '件', unitEn: 'units', packLabel: '件', packPerUnit: 1,
      miniLabel: '对', miniPerUnit: 1, rows: [], fx, margin: 0.5, autoMargin: 0.5,
      marginManual: false, errors, warnings, notes, description: '', specs: [],
    })
  }
  if (m.kind === 'jar' && !E.jars[String(input.jar)]) {
    warnings.push(`未收录罐型「${input.jar}」，已按 100g 常规罐核算。`)
  }
  const packs = ceil(pairs / pack.perPack)
  const billedPairs = packs * pack.perPack
  const membranePerPair = m.kind === 'silicone' ? (pairs >= 10000 ? 1.74 : 2.0) : Math.max(m.floorPrice, m.floorTotal / pairs)
  const membranePerPack = membranePerPair * pack.perPack

  let bagPerPair = 0
  if (!pack.isJar) {
    const cfg = pack.kind === 'waterbag' ? E.bagPrice.water : E.bagPrice.gel
    bagPerPair = pairs < cfg.minQty ? cfg.minTotal / pairs : pickDesc(cfg.tiers, pairs)
  }
  const containerPerPack = pack.isJar ? pack.jarPrice! : bagPerPair * pack.perPack
  const colors = pack.isJar ? 0 : Math.max(0, num(input.plateColors, 4))
  const plateTotal = colors * E.platePerColor
  let label = 0
  let silk = 0
  if (pack.isJar && input.print === '瓶标') label = packs <= 3000 ? 800 / packs : packs >= 5000 ? 0.25 : 0.30
  if (pack.isJar && input.print === '丝印') silk = packs <= 2500 ? 1000 / packs : packs <= 4999 ? 0.4 : packs <= 9999 ? 0.3 : 0.2
  const boxUnit = pack.boxed ? pickAsc(E.box, packs) : 0
  const trayOn = pack.boxed && input.innerTray === '是'
  const trayUnit = trayOn ? (packs <= 1000 ? 0.2 : 0.1) : 0
  const laborUnit = pack.boxed ? E.laborPerBox : 0
  const autoMargin = pairs >= 120000 ? 0.35 : pairs >= 30000 ? 0.47 : 0.53
  const margin = marginOverride == null ? autoMargin : marginOverride

  const rows = [
    { key: 'membrane', name: '膜材', nameEn: 'Mask patch', basis: `${input.material} · ${membranePerPair.toFixed(3)} 元/对 × ${pack.perPack} 对/件${m.kind === 'silicone' ? '（≥1万对 1.74 元）' : m.floorTotal > 0 ? `（批次底价 ¥${m.floorTotal.toLocaleString('en-US')} 平摊）` : '（平价 0.30 元/对）'}`, total: membranePerPack * packs },
    { key: 'container', name: pack.isJar ? '罐体包材' : '袋装包材', nameEn: 'Container', basis: pack.isJar ? `${input.jar} · ${pack.jarPrice!.toFixed(2)} 元/罐` : `${pack.kind === 'waterbag' ? '水凝胶袋' : '凝胶/硅胶袋'} · ${bagPerPair.toFixed(2)} 元/对 × ${pack.perPack} 对/件`, total: containerPerPack * packs },
    { key: 'plate', name: '袋子版费', nameEn: 'Bag plate fee', basis: pack.isJar ? '罐装免版费' : `${colors} 色 × ¥${E.platePerColor} = ¥${plateTotal.toLocaleString('en-US')}，按 ${packs.toLocaleString('en-US')} 件平摊`, total: plateTotal },
    { key: 'print', name: '瓶标 / 丝印', nameEn: 'Decoration', basis: pack.isJar ? (input.print === '瓶标' ? (packs <= 3000 ? '≤3000 瓶固定 ¥800 平摊' : '瓶标 0.25–0.30 元/件') : (packs <= 2500 ? '≤2500 瓶固定 ¥1,000 平摊' : '丝印 0.20–0.40 元/件')) : '袋装自带专版印刷', total: (label + silk) * packs },
    { key: 'box', name: '外彩盒', nameEn: 'Color box', basis: pack.boxed ? `${packs.toLocaleString('en-US')} 件 · ${boxUnit.toFixed(2)} 元/件` : '未选外彩盒', total: boxUnit * packs },
    { key: 'tray', name: '吸塑内托', nameEn: 'Inner tray', basis: trayOn ? `${packs <= 1000 ? '≤1000' : '>1000'} 件 · ${trayUnit.toFixed(2)} 元/件` : pack.boxed ? '未加内托' : '无彩盒不加内托', total: trayUnit * packs },
    { key: 'labor', name: '组装人工', nameEn: 'Assembly labor', basis: pack.boxed ? '盒装 0.50 元/件' : '散装/裸罐无装盒人工', total: laborUnit * packs },
  ]
  if (m.floorTotal > 0 && pairs < m.moq) warnings.push(`低于该膜材起订量 ${m.moq.toLocaleString('en-US')} 对，膜材按批次底价 ¥${m.floorTotal.toLocaleString('en-US')} 平摊。`)
  if (pairs % pack.perPack !== 0) warnings.push(`订购对数不是 ${pack.perPack} 对/件的整数倍，按 ${packs.toLocaleString('en-US')} 件整件计费（折合 ${billedPairs.toLocaleString('en-US')} 对）。`)
  if (pack.isJar && input.print === '瓶标' && packs <= 3000) notes.push('瓶标开机费 ¥800 平摊；超过 3,000 件改按 0.25–0.30 元/件计。')
  if (pack.isJar && input.print === '丝印' && packs <= 2500) notes.push('丝印开机费 ¥1,000 平摊；超过 2,500 件进入 0.40 元档。')
  if (!pack.isJar) notes.push('袋装自带专版印刷，按色数收取 ¥300/色版费；罐装免版费。')
  if (pairs >= 120000) notes.push('已进入 12 万对战略阶梯，享 35% 官方底价毛利。')
  else if (pairs >= 30000) notes.push('已达 3 万对档，进入 47% 官方毛利阶梯。')

  const unitLabel = pack.isJar ? '罐' : pack.boxed ? '盒' : '袋'
  return finalize({
    qty: packs,
    orderQty: pairs,
    packs,
    unitLabel,
    unitEn: pack.isJar ? 'jars' : pack.boxed ? 'boxes' : 'sachets',
    packLabel: unitLabel,
    packPerUnit: 1,
    miniLabel: '对',
    miniPerUnit: pack.perPack,
    rows,
    fx,
    margin,
    autoMargin,
    marginManual: marginOverride != null,
    errors,
    warnings,
    notes,
    description: `${input.product} · ${input.material} · ${pack.packName}`,
    specs: [
      ['产品品类', String(input.product)],
      ['膜材材质', String(input.material)],
      ['包装形式', pack.packName],
      ['订购总量', `${pairs.toLocaleString('en-US')} 对（折合 ${packs.toLocaleString('en-US')} 件）`],
      ['印刷工艺', pack.isJar ? String(input.print) : `袋装专版印刷 · ${colors} 色`],
    ],
  })
}

function computeEyemask(input: QuoteInput, fx: number, marginOverride: number | null): QuoteResult {
  const pairs = Math.max(1, Math.floor(num(input.qtyPairs, 1)))
  const base = eyeAt(input, pairs, fx, marginOverride)
  base.tiers = DATA.eyemask.tiers.map(([q, label, labelEn]) => {
    const r = eyeAt(input, q, fx, null)
    return { qty: q, label, labelEn, packs: r.packs, margin: r.autoMargin, unitCost: r.unitCost, unitPrice: r.unitPrice, unitFob: r.unitFob, miniPrice: r.miniPrice, totalUSD: r.revenueUSD }
  })
  return base
}

const COMPUTE: Record<CategoryId, (input: QuoteInput, fx: number, margin: number | null) => QuoteResult> = {
  mask: computeMask,
  cotton: computeCotton,
  oil: computeOil,
  cream: computeCream,
  eyemask: computeEyemask,
}

export function compute(categoryId: CategoryId, input: QuoteInput, opts: ComputeOptions = {}): QuoteResult {
  const fx = num(opts.fx ?? FX_DEFAULT, FX_DEFAULT)
  if (!(fx > 0)) return failed(['美元汇率必须大于 0'])
  let marginOverride: number | null = null
  if (opts.margin != null) {
    const m = num(opts.margin, NaN)
    if (!Number.isFinite(m) || m < 0 || m >= 0.95) return failed(['目标毛利率须在 0% – 95% 之间'])
    marginOverride = m
  }
  const res = COMPUTE[categoryId](input, fx, marginOverride)
  res.categoryId = categoryId
  return res
}

export function autoMargin(categoryId: CategoryId, input: QuoteInput): number {
  if (categoryId === 'mask') {
    const q = num(input.totalPieces, 1)
    return q > 20000 ? 0.15 : q > 10000 ? 0.25 : 0.35
  }
  if (categoryId === 'cotton') {
    const q = num(input.qty, 1)
    const isIce = String(input.material).indexOf('冰冰') >= 0
    return isIce
      ? q >= 10000 ? 0.15 : q >= 5000 ? 0.2 : 0.3
      : q >= 10000 ? 0.15 : q >= 5000 ? 0.2 : q >= 2000 ? 0.25 : 0.3
  }
  if (categoryId === 'oil') {
    const q = num(input.qty, 1)
    return q > 5000 ? 0.23 : q > 2000 ? 0.35 : q > 500 ? 0.47 : 0.53
  }
  if (categoryId === 'cream') {
    const q = num(input.qty, 1)
    return q >= 10000 ? 0.16 : q >= 5000 ? 0.2 : q >= 2000 ? 0.3 : 0.35
  }
  const pairs = num(input.qtyPairs, 1)
  return pairs >= 120000 ? 0.35 : pairs >= 30000 ? 0.47 : 0.53
}

export function categoryLabel(categoryId: CategoryId) {
  return CATEGORIES.find((c) => c.id === categoryId)!
}
