import { CATEGORIES, DATA, type CategoryId, type QuoteInput } from './data'
import type { QuoteResult } from './engine'

export const TIER_NOTES: Record<CategoryId, string[]> = {
  mask: [
    '试单打样：袋子按 1 万片总价 ¥3,000 平摊，彩盒与版费占比高',
    '试销测款：彩盒进入阶梯价，跨境小批量首批常用',
    '标准起订 MOQ：袋子达 1 万个转按 0.30 元/个，边际成本进入平稳区',
    '常规返单：跨入 25% 毛利档，彩盒与版费进一步摊薄',
    '大宗采购：袋子 0.28 元，跨入 15% 极限毛利档',
    '战略大客户：膜片 1.20 元 + 袋子 0.25 元，出海底价',
  ],
  cotton: [
    '试单打样：罐装 3.60 元，瓶标/丝印开机费摊薄较高',
    '试销测款：罐装跨入 3.20 元档，成本显著下降',
    '印刷门槛：接近瓶标 3,000 件门槛，跨过后按 0.30 元/张计',
    '核心推荐 MOQ：彩盒 1.00 元档，整件性价比最高',
    '大宗采购：罐子 2.80 元底价，跨入 15% 毛利档',
    '战略大客户：全链路规模效应最大化，适合连锁商超',
  ],
  oil: [
    '试单起步：≤500 瓶，彩盒固定费与印刷开机费均摊偏高',
    '小单快反：彩盒直降，丝印开机费减半，小单首选',
    '标准起订：2,000 瓶档，彩盒进入常规阶梯价',
    '品牌进阶：跨过 3,000 瓶，瓶标改按 0.24 元/张计',
    '规模定制：丝印 0.30 元、瓶标 0.24 元，主推黄金量',
    '战略大单：丝印 0.20 元，全链条边际成本最低',
  ],
  cream: [
    '打样测款：包材原价，瓶标/丝印与彩盒均摊较高',
    '试销起步：彩盒进入正常阶梯，单支成本显著回落',
    '经济采购：2,000 支起，毛利档降至 30%',
    '核心推荐 MOQ：包材享 9 折，彩盒进入低档',
    '规模采购：丝印 0.30 元，彩盒低至 0.80 元',
    '大宗爆款：包材 85 折，丝印 0.20 元，毛利 16%',
    '战略集采：全链路底价，适合年度框架协议',
  ],
  eyemask: [
    '首单测试 / 低库存试销：彩盒与印刷开机费均摊偏高，促单主推方案',
    '常规小单轻定制首选：达到起订线，性价比显著优化',
    '中小电商品牌常规返单：彩盒进入 1.15 元主流区间',
    '关键临界点：达 3 万对跨入 47% 毛利阶梯，膜材降至 0.08 元平价',
    '主推黄金采购量：达到大单特惠线，全链条边际成本显著降低',
    '12 万对 KA 连锁 / 海外大宗战略采购：35% 官方底价毛利，成本最低',
  ],
}

export const EN = {
  packForm: { 罐装: 'Jar', 袋装: 'Sachet' },
  material: {
    '无纺布（传统棉）': 'Non-woven cotton',
    冰冰棉: 'Ice-cotton',
    罐装膜材: 'Jar-packed patches',
    '片装水凝胶（吸塑）': 'Hydrogel sachet',
    '凝胶眼膜（贴布-定制Logo）': 'Gel patch (custom logo)',
    '凝胶眼膜（贴布-不定制Logo）': 'Gel patch (stock logo)',
    '硅胶眼膜（吸盘）': 'Silicone patch',
  },
  category: { 精油类: 'Essential Oil', 精华类: 'Serum' },
  bottle: {
    '滴管瓶（玻璃）': 'Glass dropper bottle',
    '精油瓶（玻璃）': 'Glass essential-oil bottle',
    '滴管瓶（塑料）': 'Plastic dropper bottle',
    '尖嘴瓶（塑料）': 'Plastic pointed-tip bottle',
    '泵头瓶（塑料）': 'Plastic pump bottle',
  },
  bulkType: {
    普通面霜: 'Standard face cream',
    '胶囊面霜、眼霜、洗面奶、防晒霜': 'Capsule cream / eye cream / cleanser / sunscreen',
    功效型面霜: 'Functional face cream',
    '撕拉面膜、牛脂膏、磨砂膏': 'Peel-off mask / tallow balm / scrub',
    固体膏类: 'Solid balm',
    '爽肤水、凝胶啫喱、身体乳': 'Toner / gel / body lotion',
  },
  container: {
    '亚克力罐（面霜）': 'Acrylic jar',
    '玻璃罐（面霜）': 'Glass jar',
    'PE塑料罐（磨砂膏、牛脂膏、身体乳）': 'PE jar',
    软管: 'Soft tube',
    铝管: 'Aluminum tube',
    '膏体管（唇膏、保湿棒）': 'Stick tube',
    'PET塑料瓶（爽肤水）': 'PET bottle',
  },
  print: { 瓶标: 'Label', 丝印: 'Silkscreen', 无: 'None', 无印刷: 'None' },
  product: { 眼膜: 'Eye Mask', 唇膜: 'Lip Mask' },
  jar: {
    '50g常规罐': '50 g jar',
    '100g常规罐': '100 g jar',
    '120g常规罐': '120 g jar',
    '36对高档旋转罐': '36-pair rotating jar',
    '无需包材（客户自备）': 'Customer-supplied jar',
  },
} as Record<string, Record<string, string>>

export function todayLocal() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function fmt(n: number, d = 2) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

export function fmtInt(n: number) {
  return Math.round(Number(n)).toLocaleString('en-US')
}

export function pct(m: number) {
  const v = m * 100
  return `${Math.abs(v - Math.round(v)) < 1e-9 ? v.toFixed(0) : v.toFixed(1)}%`
}

export const money2 = (n: number) => `$${fmt(n, 2)}`
export const money3 = (n: number) => `$${fmt(n, 3)}`

export function qtyText(catId: CategoryId, r: QuoteResult) {
  if (catId === 'mask') return `${fmtInt(r.qty)} 片${r.packs ? `（${fmtInt(r.packs)} 盒）` : ''}`
  if (catId === 'eyemask')
    return r.packLabel === r.miniLabel
      ? `${fmtInt(r.orderQty)} 对`
      : `${fmtInt(r.orderQty)} 对（${fmtInt(r.packs)} ${r.packLabel}）`
  return `${fmtInt(r.qty)} ${r.unitLabel}`
}

export function hasPacks(catId: CategoryId, r: QuoteResult) {
  return catId === 'mask' ? !!r.packs : catId === 'eyemask' ? r.packLabel !== r.miniLabel : r.packs !== r.qty
}

export const showMini = (r: QuoteResult) => r.miniLabel !== r.unitLabel

export function quoteNo(date: string, categoryId: CategoryId) {
  const cat = CATEGORIES.find((c) => c.id === categoryId)!
  return `JY-${String(date).replace(/-/g, '')}-${cat.code}`
}

export function secondaryKpi(categoryId: CategoryId, r: QuoteResult) {
  if (categoryId === 'mask') {
    if (r.packPerUnit > 1) {
      return { label: '整盒报价', en: 'per box', value: money3(r.packFob), foot: `出厂价 ¥${fmt(r.packPrice)} / 盒（${r.packPerUnit} 片）` }
    }
    return { label: '每千片报价', en: 'per 1,000 pcs', value: money3(r.unitFob * 1000), foot: `出厂价 ¥${fmt(r.unitPrice * 1000)} / 千片` }
  }
  if (categoryId === 'cotton') return { label: '单片报价', en: 'per pad', value: money3(r.miniFob), foot: `出厂价 ¥${fmt(r.miniPrice)} / 片` }
  if (categoryId === 'oil') return { label: '每 ml 报价', en: 'per ml', value: money3(r.miniFob), foot: `出厂价 ¥${fmt(r.miniPrice)} / ml` }
  if (categoryId === 'cream') return { label: '每 g/ml 报价', en: 'per g/ml', value: money3(r.miniFob), foot: `出厂价 ¥${fmt(r.miniPrice)} / g/ml` }
  if (r.unitLabel === r.miniLabel) {
    return { label: '每千对报价', en: 'per 1,000 pairs', value: money3(r.miniFob * 1000), foot: `出厂价 ¥${fmt(r.miniPrice * 1000)} / 千对` }
  }
  return { label: '每对报价', en: 'per pair', value: money3(r.miniFob), foot: `出厂价 ¥${fmt(r.miniPrice)} / 对（${r.miniPerUnit} 对/${r.unitLabel}）` }
}

export function tierQtyHead(categoryId: CategoryId) {
  if (categoryId === 'mask') return '订购片数'
  if (categoryId === 'cotton') return '订购量（罐/袋）'
  if (categoryId === 'oil') return '订购量（瓶）'
  if (categoryId === 'cream') return '订购量（支/罐）'
  return '订购总对数'
}

function en(v: unknown, map?: Record<string, string>) {
  const key = String(v)
  return map?.[key] || key
}

export function specLine(categoryId: CategoryId, input: QuoteInput) {
  if (categoryId === 'mask') {
    const pt = input.colorBox === '否' ? 'Single sachet' : `Boxed · ${input.piecesPerBox} pcs/box`
    return `Sheet Mask · ${pt} · ${input.colors}-color printing`
  }
  if (categoryId === 'cotton') {
    return `Wet Compress Cotton Pads · ${en(input.packForm, EN.packForm)} · ${input.padsPerUnit} pads/unit · ${en(input.material, EN.material)}${input.packForm === '罐装' ? ' · ' + en(input.print, EN.print) : ''}`
  }
  if (categoryId === 'oil') return `${en(input.category, EN.category)} · ${en(input.bottle, EN.bottle)} · ${input.capacity} ml · ${en(input.print, EN.print)}`
  if (categoryId === 'cream') return `${en(input.bulkType, EN.bulkType)} · ${en(input.container, EN.container)} · ${input.capacity} ml/g · ${en(input.print, EN.print)}`
  const m = DATA.eyemask.membranes[String(input.material)] || ({} as { kind?: string })
  const perJar = Math.floor(Number(input.pairsPerJar)) || DATA.eyemask.jars[String(input.jar)]?.pairs || 1
  const perBox = Math.floor(Number(input.pairsPerBox)) || Number(DATA.eyemask.defaults.pairsPerBox) || 6
  const pack =
    m.kind === 'jar'
      ? `${en(input.jar, EN.jar)} · ${perJar} pairs / jar`
      : input.bagPack === '否'
        ? 'Bulk patches (no bag)'
        : input.colorBox === '是'
          ? `${perBox} pairs / box`
          : 'Single sachet'
  return `${en(input.product, EN.product)} · ${en(input.material, EN.material)} · ${pack}`
}

export interface QuoteMeta {
  client: string
  date: string
  fx: number
}

export function buyerText(categoryId: CategoryId, input: QuoteInput, r: QuoteResult, meta: QuoteMeta) {
  const cat = CATEGORIES.find((c) => c.id === categoryId)!
  const L: string[] = []
  const qtyEn = categoryId === 'eyemask' ? 'pairs' : categoryId === 'mask' ? 'pcs' : r.unitEn
  L.push('FOSHAN JINGYAN BIOLOGICAL PRODUCTS CO., LTD.')
  L.push('OEM / ODM QUOTATION  报价单')
  L.push('')
  L.push('Quotation No.: ' + quoteNo(meta.date, categoryId))
  L.push('Date: ' + meta.date)
  L.push('Client: ' + (meta.client || '-'))
  L.push('Product: ' + cat.cn + ' / ' + cat.en)
  L.push('Specification: ' + specLine(categoryId, input))
  L.push(
    'Quantity: ' +
      (categoryId === 'eyemask'
        ? r.unitEn === 'pairs'
          ? `${fmtInt(r.orderQty)} pairs`
          : `${fmtInt(r.orderQty)} pairs (${fmtInt(r.packs)} ${r.unitEn})`
        : categoryId === 'mask'
          ? `${fmtInt(r.qty)} pcs${r.packs ? ` (${fmtInt(r.packs)} boxes)` : ''}`
          : `${fmtInt(r.qty)} ${r.unitEn}`),
  )
  L.push(
    'Unit Price: USD ' +
      fmt(r.unitFob, 3) +
      ' / ' +
      r.unitEn +
      (categoryId === 'mask' && r.packPerUnit > 1 ? `  |  USD ${fmt(r.packFob, 3)} / box (${r.packPerUnit} pcs)` : '') +
      (categoryId === 'eyemask' && r.unitLabel !== r.miniLabel ? `  |  USD ${fmt(r.miniFob, 3)} / pair` : ''),
  )
  L.push('Order Value: USD ' + fmt(r.revenueUSD))
  L.push('Exchange Rate: 1 USD = ' + fmt(meta.fx, 2) + ' CNY · Price basis: FOB (EXW on request)')
  L.push('')
  L.push('Volume Price (USD):')
  r.tiers.forEach((t) => {
    const per =
      (categoryId === 'mask' && r.packPerUnit > 1 ? ` · USD ${fmt(t.unitFob * r.packPerUnit, 3)} / box` : '') +
      (categoryId === 'eyemask' && r.unitLabel !== r.miniLabel ? ` · USD ${fmt(t.miniPrice / r.fx, 3)} / pair` : '')
    L.push(`  · ${fmtInt(t.qty)} ${qtyEn} → USD ${fmt(t.unitFob, 3)} / ${r.unitEn}${per}  (margin tier, subject to artwork confirmation)`)
  })
  L.push('')
  L.push('Lead Time: 25–35 days after deposit & artwork approval')
  L.push('Payment: 30% T/T deposit, 70% before shipment')
  L.push('Validity: 30 days')
  L.push('Packing: Export carton')
  L.push('Compliance: ISO 22716 / GMPC; third-party testing on request')
  return L.join('\n')
}

export function internalText(categoryId: CategoryId, r: QuoteResult, meta: QuoteMeta) {
  const cat = CATEGORIES.find((c) => c.id === categoryId)!
  const L: string[] = []
  L.push(`内部核算 · ${cat.cn} · ${quoteNo(meta.date, categoryId)}`)
  L.push(`客户：${meta.client || '-'}　日期：${meta.date}　汇率：1 USD = ${fmt(meta.fx, 2)} CNY`)
  L.push(`规格：${r.description}`)
  r.specs.forEach(([k, v]) => L.push(`  ${k}：${v}`))
  L.push('')
  L.push(
    `订单量：${qtyText(categoryId, r)}　单${r.unitLabel}成本：¥${fmt(r.unitCost)}　建议报价：¥${fmt(r.unitPrice)} / ${money3(r.unitFob)}　毛利率：${pct(r.margin)}${r.marginManual ? '（手动）' : '（自动）'}`,
  )
  L.push(
    `总成本：¥${fmt(r.costTotal)}（${money2(r.costTotal / r.fx)}）　总货值：¥${fmt(r.revenueRMB)}（${money2(r.revenueUSD)}）　毛利：¥${fmt(r.profitRMB)}（${money2(r.profitUSD)}）`,
  )
  L.push('')
  L.push('成本明细：')
  r.costs.forEach((c) => L.push(`  · ${c.name}：¥${fmt(c.total)}（单${r.unitLabel} ¥${fmt(c.perUnit)}，占比 ${pct(c.share)}）— ${c.basis}`))
  L.push('')
  L.push('阶梯对比：')
  r.tiers.forEach((t) =>
    L.push(
      `  · ${fmtInt(t.qty)} ${categoryId === 'eyemask' ? '对' : ''}${hasPacks(categoryId, r) ? `（${fmtInt(t.packs)} ${r.packLabel}）` : ''}｜毛利 ${pct(t.margin)}｜成本 ¥${fmt(t.unitCost)}｜报价 ¥${fmt(t.unitPrice)}｜FOB ${fmt(t.unitFob, 3)}｜总货值 ${money2(t.totalUSD)}`,
    ),
  )
  if (r.warnings.length || r.notes.length) {
    L.push('')
    r.warnings.forEach((w) => L.push('⚠ ' + w))
    r.notes.forEach((n) => L.push('· ' + n))
  }
  return L.join('\n')
}

export function tierCsv(categoryId: CategoryId, r: QuoteResult) {
  const packed = hasPacks(categoryId, r)
  const mini = showMini(r)
  const miniRmb = categoryId === 'eyemask'
  const head = ['梯队', '英文', tierQtyHead(categoryId)]
    .concat(packed ? [`折合${r.packLabel}`] : [])
    .concat(['毛利率', `单${r.unitLabel}成本(RMB)`, `单${r.unitLabel}报价(RMB)`, `单${r.unitLabel}FOB(USD)`])
    .concat(mini ? [miniRmb ? `折合单${r.miniLabel}价(RMB)` : `${r.miniLabel}FOB(USD)`] : [])
    .concat(['订单总货值(USD)'])
  const rows = r.tiers.map((t) =>
    [t.label, t.labelEn, String(t.qty)]
      .concat(packed ? [String(t.packs)] : [])
      .concat([pct(t.margin), t.unitCost.toFixed(4), t.unitPrice.toFixed(4), t.unitFob.toFixed(4)])
      .concat(mini ? [miniRmb ? t.miniPrice.toFixed(4) : (t.miniPrice / r.fx).toFixed(4)] : [])
      .concat([t.totalUSD.toFixed(2)]),
  )
  const current = ['当前报价', '', String(r.orderQty)]
    .concat(packed ? [String(r.packs)] : [])
    .concat([pct(r.margin), r.unitCost.toFixed(4), r.unitPrice.toFixed(4), r.unitFob.toFixed(4)])
    .concat(mini ? [miniRmb ? r.miniPrice.toFixed(4) : r.miniFob.toFixed(4)] : [])
    .concat([r.revenueUSD.toFixed(2)])
  return [head, ...rows, current]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\r\n')
}
