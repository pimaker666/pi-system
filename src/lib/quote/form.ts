import { DATA, type CategoryId, type QuoteInput } from './data'

export interface FormOption {
  value: string
  label: string
}

export interface FormField {
  type: 'select' | 'number'
  key: string
  label: string
  labelEn: string
  hint?: string
  unit?: string
  min?: number
  presets?: number[]
  options?: FormOption[]
  visible?: (input: QuoteInput) => boolean
}

/** Select keys whose values must be stored as numbers (they index pricing tables). */
export const NUMERIC_KEYS = new Set(['piecesPerBox', 'padsPerUnit', 'capacity', 'colors', 'plateColors'])

const opt = (value: string | number, label?: string): FormOption => ({
  value: String(value),
  label: label ?? String(value),
})


export function fieldsFor(categoryId: CategoryId, input: QuoteInput): FormField[] {
  if (categoryId === 'mask') {
    return [
      {
        type: 'select', key: 'packageType', label: '包装形态', labelEn: 'Package form',
        options: [opt('盒装', '盒装 Boxed'), opt('片装', '片装 Single sachet')],
        hint: '片装自动免除彩盒、内托与 0.80 元/盒装盒人工。',
      },
      {
        type: 'select', key: 'piecesPerBox', label: '每盒片数', labelEn: 'Pieces / box',
        options: [opt(4, '4 片'), opt(5, '5 片'), opt(10, '10 片')],
        hint: '外贸常用 4 / 5 / 10 片装；彩盒按盒数阶梯计价。',
        visible: (s) => s.packageType === '盒装',
      },
      {
        type: 'number', key: 'totalPieces', label: '定制总片数', labelEn: 'Total pieces', unit: '片',
        presets: DATA.mask.tiers.map((t) => t[0]), min: 100,
        hint: '彩盒与 350 元/色版费按总片数平摊，盒数向上取整。',
      },
      {
        type: 'select', key: 'innerTray', label: '彩盒内托', labelEn: 'Inner tray',
        options: [opt('否', '不加内托'), opt('是', '加吸塑内托')],
        hint: '≤1,000 盒 0.20 元/盒；>1,000 盒 0.10 元/盒。',
        visible: (s) => s.packageType === '盒装',
      },
      {
        type: 'select', key: 'colors', label: '印刷色版数', labelEn: 'Print colors',
        options: [1, 2, 3, 4, 5, 6].map((v) => opt(v, v + ' 色' + (v === 4 ? '（默认）' : ''))),
        hint: '350 元/色，全额按总片数平摊入单价。',
      },
    ]
  }

  if (categoryId === 'cotton') {
    return [
      {
        type: 'select', key: 'packForm', label: '包装形态', labelEn: 'Package form',
        options: [opt('罐装', '罐装 Jar'), opt('袋装', '袋装 Sachet')],
        hint: '罐装与袋装互斥核算；袋装默认不需要罐子。',
      },
      {
        type: 'select', key: 'padsPerUnit', label: '每件片数', labelEn: 'Pads / unit',
        options: [opt(60, '60 片（110 ml）'), opt(70, '70 片（120 ml）'), opt(100, '100 片（140 ml）')],
        hint: '常规装：60 片配 110 ml，70 片配 120 ml，100 片配 140 ml。',
      },
      {
        type: 'number', key: 'qty', label: '定制总量', labelEn: 'Order quantity', unit: '罐/袋',
        presets: DATA.cotton.tiers.map((t) => t[0]), min: 1,
        hint: '罐装 500 起订；袋装 1 万起订，不足按 1 万个总价 ¥3,000 平摊。',
      },
      {
        type: 'select', key: 'colorBox', label: '外彩盒', labelEn: 'Color box',
        options: [opt('是', '配专版彩盒'), opt('否', '裸罐 / 裸袋出厂')],
        hint: '彩盒依订量阶梯 0.95–2.00 元；仅配盒时产生 0.80 元人工。',
      },
      {
        type: 'select', key: 'innerTray', label: '彩盒内托', labelEn: 'Inner tray',
        options: [opt('是', '加吸塑内托'), opt('否', '不加内托')],
        hint: '≤1,000 件 0.20 元；>1,000 件 0.10 元。',
        visible: (s) => s.colorBox === '是',
      },
      {
        type: 'select', key: 'print', label: '瓶身印刷', labelEn: 'Decoration',
        options: [opt('瓶标', '瓶标 Label'), opt('丝印', '丝印 Silkscreen'), opt('无', '无印刷 None')],
        hint: '罐装专享，瓶标与丝印互斥；袋装自带专版印刷，自动计 0 元。',
        visible: (s) => s.packForm === '罐装',
      },
    ]
  }

  if (categoryId === 'oil') {
    const caps = Object.keys(DATA.oil.bottles[String(input.bottle)] || {})
      .map(Number)
      .sort((a, b) => a - b)
    return [
      {
        type: 'select', key: 'category', label: '定制品类', labelEn: 'Product category',
        options: [opt('精油类', '精油类 · 0.035 元/ml'), opt('精华类', '精华类 · 0.050 元/ml')],
        hint: '精油 35 元/升；精华原液 50 元/升。',
      },
      {
        type: 'select', key: 'bottle', label: '瓶子器型', labelEn: 'Bottle type',
        options: Object.keys(DATA.oil.bottles).map((v) => opt(v)),
        hint: '器型与容量联动；参数字典未收录的组合会直接报错，不会按 0 元计。',
      },
      {
        type: 'select', key: 'capacity', label: '灌装容量', labelEn: 'Capacity',
        options: caps.map((v) => opt(v, v + ' ml')),
        hint: '容量选项随器型动态切换，价格取自官方《参数字典》。',
      },
      {
        type: 'number', key: 'qty', label: '定制总量', labelEn: 'Order quantity', unit: '瓶',
        presets: DATA.oil.tiers.map((t) => t[0]), min: 1,
        hint: '500 瓶起订，支持任意数量直接输入。',
      },
      {
        type: 'select', key: 'colorBox', label: '外彩盒', labelEn: 'Color box',
        options: [opt('是', '配专版彩盒'), opt('否', '裸瓶出厂')],
        hint: '彩盒按容量段与订量阶梯 0.70–1.80 元；≤500 盒为固定费平摊。',
      },
      {
        type: 'select', key: 'innerTray', label: '彩盒内托', labelEn: 'Inner tray',
        options: [opt('是', '加吸塑内托'), opt('否', '不加内托')],
        hint: '≤100 ml 0.10 元；101–200 ml 0.15 元；>200 ml 0.20 元。',
        visible: (s) => s.colorBox === '是',
      },
      {
        type: 'select', key: 'print', label: '瓶身印刷', labelEn: 'Decoration',
        options: [opt('瓶标', '瓶标 Label'), opt('丝印', '丝印 Silkscreen'), opt('无', '无印刷 None')],
        hint: '瓶标与丝印互斥二选一；裸瓶标/丝印 0.30 元人工，裸瓶简装 0.10 元。',
      },
    ]
  }

  if (categoryId === 'cream') {
    return [
      {
        type: 'select', key: 'bulkType', label: '料体品类', labelEn: 'Formula type',
        options: Object.keys(DATA.cream.bulk).map((v) => opt(v, `${v} · ${DATA.cream.bulk[v].kg} 元/kg`)),
        hint: '料体单价为官方公斤价，按容量折算克成本，标准含 3% 损耗。',
      },
      {
        type: 'select', key: 'container', label: '包装器型', labelEn: 'Container',
        options: Object.keys(DATA.cream.containers).map((v) => opt(v)),
        hint: '包材 3,000–9,999 件享 9 折，≥10,000 件享 85 折。',
      },
      {
        type: 'select', key: 'capacity', label: '容量规格', labelEn: 'Capacity',
        options: DATA.cream.capacities.map((v) => opt(v, v + ' ml/g')),
        hint: '容量价格取自官方《参数字典》器型 × 容量矩阵。',
      },
      {
        type: 'number', key: 'qty', label: '定制总量', labelEn: 'Order quantity', unit: '支/罐',
        presets: DATA.cream.tiers.map((t) => t[0]), min: 1,
        hint: '500 起订；配盒人工 0.80 元/盒，裸瓶 0.40 元/瓶。',
      },
      {
        type: 'select', key: 'colorBox', label: '外彩盒', labelEn: 'Color box',
        options: [opt('是', '配专版彩盒'), opt('否', '裸瓶出厂')],
        hint: '彩盒按容量段与订量阶梯 0.70–1.80 元，≤500 盒为固定费平摊。',
      },
      {
        type: 'select', key: 'innerTray', label: '彩盒内托', labelEn: 'Inner tray',
        options: [opt('是', '加吸塑内托'), opt('否', '不加内托')],
        hint: '≤100 ml 0.10 元；101–200 ml 0.15 元；>200 ml 0.20 元。',
        visible: (s) => s.colorBox === '是',
      },
      {
        type: 'select', key: 'print', label: '瓶身印刷', labelEn: 'Decoration',
        options: [opt('瓶标', '瓶标 Label'), opt('丝印', '丝印 Silkscreen'), opt('无', '无印刷 None')],
        hint: '瓶标与丝印互斥；瓶标 ≤3,000 固定 ¥800，丝印 ≤2,500 固定 ¥1,000。',
      },
    ]
  }

  const isJarKind = (s: QuoteInput) => (DATA.eyemask.membranes[String(s.material)] || { kind: '' }).kind === 'jar'
  return [
    {
      type: 'select', key: 'product', label: '产品品类', labelEn: 'Product',
      options: [opt('眼膜', '眼膜 Eye Mask'), opt('唇膜', '唇膜 Lip Mask')],
      hint: '眼膜主推水润抚纹；唇膜主打温和去角质与深润淡唇纹。',
    },
    {
      type: 'select', key: 'material', label: '膜材类型', labelEn: 'Patch material',
      options: Object.keys(DATA.eyemask.membranes).map((v) => opt(v)),
      hint: '膜材起订量与批次底价不同；不足起订按批次底价平摊。',
    },
    {
      type: 'select', key: 'jar', label: '罐装容器', labelEn: 'Jar',
      options: Object.keys(DATA.eyemask.jars).map((v) => opt(v, `${v} · ${DATA.eyemask.jars[v].price.toFixed(2)} 元`)),
      hint: '仅罐装膜材使用；50g / 100g / 120g 常规罐与高档旋转罐。',
      visible: isJarKind,
    },
    {
      type: 'select', key: 'colorBox', label: '外彩盒', labelEn: 'Color box',
      options: [opt('是', '配彩盒'), opt('否', '裸罐 / 单袋散装')],
      hint: '袋装选“否”即单袋散装；彩盒按件数阶梯 0.95–2.00 元。',
    },
    {
      type: 'select', key: 'innerTray', label: '彩盒内托', labelEn: 'Inner tray',
      options: [opt('是', '加吸塑内托'), opt('否', '不加内托')],
      hint: '≤1,000 件 0.20 元；>1,000 件 0.10 元；罐装与 6 对盒装通用，单袋散装不产生内托。',
      visible: (s) => s.colorBox === '是',
    },
    {
      type: 'select', key: 'print', label: '罐身印刷', labelEn: 'Decoration',
      options: [opt('丝印', '丝印 Silkscreen'), opt('瓶标', '瓶标 Label'), opt('无', '无印刷 None')],
      hint: '罐装专享，瓶标与丝印互斥；≤3,000 件瓶标固定 ¥800，丝印 ≤2,500 件固定 ¥1,000。',
      visible: isJarKind,
    },
    {
      type: 'select', key: 'plateColors', label: '袋子印刷色数', labelEn: 'Bag plate colors',
      options: [1, 2, 3, 4, 5, 6].map((v) => opt(v, v + ' 色 · 版费 ¥' + v * 300)),
      hint: '袋装专版印刷 300 元/色；罐装免版费。',
      visible: (s) => !isJarKind(s),
    },
    {
      type: 'number', key: 'qtyPairs', label: '定制总对数', labelEn: 'Order quantity (pairs)', unit: '对',
      presets: DATA.eyemask.tiers.map((t) => t[0]), min: 1,
      hint: '按对录入，系统自动折算 罐 / 盒 / 袋 件数并核算单件成本。',
    },
  ]
}

/** Keep dependent selects coherent when the category switch makes them meaningless. */
export function normalizeInput(categoryId: CategoryId, input: QuoteInput): QuoteInput {
  const next = { ...input }
  if (categoryId === 'eyemask') {
    const m = DATA.eyemask.membranes[String(next.material)]
    if (m && m.kind !== 'jar') next.packMode = next.colorBox === '是' ? '6对盒装' : '单袋散装'
    if (m && m.kind === 'jar') next.print = next.print === '无' || next.print == null ? '丝印' : next.print
  }
  if (categoryId === 'oil' || categoryId === 'cream') {
    const caps = categoryId === 'oil'
      ? Object.keys(DATA.oil.bottles[String(next.bottle)] || {}).map(Number)
      : DATA.cream.capacities
    if (caps.length && !caps.includes(Number(next.capacity))) next.capacity = caps[0]
  }
  return next
}
