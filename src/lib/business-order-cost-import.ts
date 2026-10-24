import { roundToScale } from '@/lib/utils'
import type { BusinessOrderProductCost } from '@/types'

/**
 * 订单成本表批量导入的解析与核对。
 *
 * 与每日订单导入不同：这里不新建任何数据，只把导入行的「成本」写回已存在的
 * 成本行（经 updateBusinessOrderItemCostOverride）。因此每行导入必须先按
 * 订单号 → 产品名称 → 数量 → 业务员 → 订单总金额 五项核对，唯一定位到系统里
 * 一条未结算成本行，才允许填入；任何一项对不上都归入「未匹配」并写明原因。
 */

export const COST_IMPORT_MAX_ROWS = 500

export type CostImportField =
  | 'order_number'
  | 'salesperson_name'
  | 'product_name'
  | 'quantity'
  | 'order_total_amount'
  | 'cost'

/** 展示用列名（同时用于「缺少必要列」提示）。 */
export const COST_IMPORT_COLUMNS: Record<CostImportField, string> = {
  order_number: '订单号',
  salesperson_name: '业务员',
  product_name: '产品名称',
  quantity: '数量',
  order_total_amount: '订单总金额',
  cost: '成本',
}

const HEADER_ALIASES: Record<CostImportField, string[]> = {
  order_number: ['订单号', '订单编号', '平台单号', '外部订单号', 'order_number', 'order no', 'order number'],
  salesperson_name: ['业务员', '销售员', 'salesperson', 'sales'],
  product_name: ['产品名称', '产品', 'product_name', 'product'],
  quantity: ['数量', 'qty', 'quantity'],
  order_total_amount: ['订单总金额', '订单金额', '订单总额', 'order_total_amount', 'total amount'],
  // 只认「成本」，导出表里的「总成本」不在别名内，因此不会被误当成成本列。
  cost: ['成本', '成本(元)', '成本（元）', 'cost'],
}

function normalizedHeader(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s_-]+/g, '')
}

const aliasIndex = Object.fromEntries(
  Object.entries(HEADER_ALIASES).flatMap(([field, aliases]) =>
    aliases.map((alias) => [normalizedHeader(alias), field]),
  ),
) as Record<string, CostImportField>

/** 从表头行定位各字段所在列；missing 为缺失的必要列。 */
export function resolveCostImportColumns(headerRow: unknown[]): {
  columns: Partial<Record<CostImportField, number>>
  missing: CostImportField[]
} {
  const columns: Partial<Record<CostImportField, number>> = {}
  headerRow.forEach((cell, index) => {
    const field = aliasIndex[normalizedHeader(cell)]
    if (field && columns[field] === undefined) columns[field] = index
  })
  const missing = (Object.keys(HEADER_ALIASES) as CostImportField[]).filter(
    (field) => columns[field] === undefined,
  )
  return { columns, missing }
}

/** 解析金额/数量单元格：剥离币种符号与千分位后转数字；空或非法返回 null。 */
function parseNumeric(value: unknown): number | null {
  const text = String(value ?? '').trim()
  if (!text) return null
  const cleaned = text.replace(
    /CNY|RMB|USD|US\$|EUR|GBP|JPY|人民币|美元|欧元|英镑|日元|[¥￥,$€£，\s]/gi,
    '',
  )
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeName(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

/** 导出的产品名称单元格是「名称\nSKU」，取首行为名称、次行为 SKU 提示。 */
function splitProductName(value: unknown): { name: string; sku: string } {
  const raw = String(value ?? '').trim()
  const [first, second] = raw.split(/\r?\n/)
  return { name: (first ?? '').trim(), sku: (second ?? '').trim() }
}

function cell(matrix: unknown[][], rowIndex: number, col: number | undefined): unknown {
  if (col === undefined) return ''
  return matrix[rowIndex]?.[col] ?? ''
}

export type CostImportCategory = 'autoFill' | 'conflict' | 'unmatched' | 'skipped'

export interface CostImportEntry {
  /** 源表格行号（表头为第 1 行，数据从第 2 行起）。 */
  rowNumber: number
  orderNumber: string
  salespersonName: string
  productName: string
  quantityText: string
  orderTotalText: string
  importedCost: number | null
  category: CostImportCategory
  /** 未匹配/跳过的原因，或冲突的说明。 */
  reason: string
  /** 命中系统行时携带，供写入与展示；未匹配为 null。 */
  itemIds: string[] | null
  systemCost: number | null
  currency: string | null
  matchedQuantity: number | null
  matchedSalesperson: string | null
  matchedOrderTotal: number | null
  /** skipped 细分：导入成本为空 / 与系统一致。 */
  skipKind?: 'empty' | 'consistent'
}

export interface CostImportMatchResult {
  autoFill: CostImportEntry[]
  conflicts: CostImportEntry[]
  unmatched: CostImportEntry[]
  skipped: CostImportEntry[]
}

function baseEntry(
  rowNumber: number,
  orderNumber: string,
  salespersonName: string,
  productName: string,
  quantityText: string,
  orderTotalText: string,
  importedCost: number | null,
): CostImportEntry {
  return {
    rowNumber,
    orderNumber,
    salespersonName,
    productName,
    quantityText,
    orderTotalText,
    importedCost,
    category: 'unmatched',
    reason: '',
    itemIds: null,
    systemCost: null,
    currency: null,
    matchedQuantity: null,
    matchedSalesperson: null,
    matchedOrderTotal: null,
  }
}

/**
 * 把导入表格与系统里的未结算成本行逐行核对并分类。
 * 表头缺列时抛错（由路由转成 400）。
 */
export function matchCostImportRows(
  matrix: unknown[][],
  systemRows: BusinessOrderProductCost[],
): CostImportMatchResult {
  const result: CostImportMatchResult = { autoFill: [], conflicts: [], unmatched: [], skipped: [] }
  if (matrix.length === 0) return result

  const { columns, missing } = resolveCostImportColumns(matrix[0])
  if (missing.length > 0) {
    throw new Error(`缺少必要列：${missing.map((field) => COST_IMPORT_COLUMNS[field]).join('、')}`)
  }

  // 订单号（含平台单号）→ 该订单的成本行；同一行可能挂在两个键下，用引用去重。
  const byOrder = new Map<string, BusinessOrderProductCost[]>()
  for (const row of systemRows) {
    for (const key of [row.order_number, row.external_order_number]) {
      const normalizedKey = (key ?? '').trim()
      if (!normalizedKey) continue
      const list = byOrder.get(normalizedKey) ?? []
      if (!list.includes(row)) list.push(row)
      byOrder.set(normalizedKey, list)
    }
  }

  const dataRowCount = Math.min(matrix.length - 1, COST_IMPORT_MAX_ROWS)
  for (let offset = 0; offset < dataRowCount; offset += 1) {
    const rowIndex = offset + 1
    const rowNumber = rowIndex + 1

    const orderNumberRaw = String(cell(matrix, rowIndex, columns.order_number) ?? '').trim()
    const { name: productName, sku: productSku } = splitProductName(
      cell(matrix, rowIndex, columns.product_name),
    )
    const salespersonName = String(cell(matrix, rowIndex, columns.salesperson_name) ?? '').trim()
    const quantityText = String(cell(matrix, rowIndex, columns.quantity) ?? '').trim()
    const orderTotalText = String(cell(matrix, rowIndex, columns.order_total_amount) ?? '').trim()
    const importedCost = parseNumeric(cell(matrix, rowIndex, columns.cost))

    // 整行为空则跳过，不计入任何分类。
    if (!orderNumberRaw && !productName && quantityText === '' && importedCost === null) continue

    const entry = baseEntry(
      rowNumber,
      orderNumberRaw,
      salespersonName,
      productName,
      quantityText,
      orderTotalText,
      importedCost,
    )

    const failUnmatched = (reason: string) => {
      entry.category = 'unmatched'
      entry.reason = reason
      result.unmatched.push(entry)
    }

    if (!orderNumberRaw) {
      failUnmatched('订单号为空')
      continue
    }

    const candidates = byOrder.get(orderNumberRaw)
    if (!candidates || candidates.length === 0) {
      failUnmatched('订单号未找到，或该订单不在未结算成本表（可能已结算、未收齐或未全部发货）')
      continue
    }

    // 产品名称：先按名称比对；未命中再用「换行后的编码」或整格值退回比对系统 SKU。
    let matched = candidates.filter(
      (row) => normalizeName(row.product_name) === normalizeName(productName),
    )
    if (matched.length === 0) {
      const skuKeys = [productSku, productName].filter((value) => normalizeName(value))
      matched = candidates.filter((row) =>
        skuKeys.some((key) => normalizeName(row.product_sku) === normalizeName(key)),
      )
    }
    if (matched.length === 0) {
      failUnmatched(`该订单下未找到产品名称「${productName || '(空)'}」的成本行`)
      continue
    }

    // 数量
    const quantity = parseNumeric(quantityText)
    if (quantity === null) {
      failUnmatched('数量为空或无法解析')
      continue
    }
    const afterQuantity = matched.filter(
      (row) => roundToScale(Number(row.quantity), 4) === roundToScale(quantity, 4),
    )
    if (afterQuantity.length === 0) {
      failUnmatched(
        `产品数量不符（系统 ${matched[0].quantity} / 导入 ${quantity}）`,
      )
      continue
    }

    // 业务员
    const afterSalesperson = afterQuantity.filter(
      (row) => (row.salesperson_name ?? '').trim() === salespersonName,
    )
    if (afterSalesperson.length === 0) {
      failUnmatched(
        `业务员不符（系统 ${afterQuantity[0].salesperson_name || '(空)'} / 导入 ${salespersonName || '(空)'}）`,
      )
      continue
    }

    // 订单金额（订单总金额）
    const orderTotal = parseNumeric(orderTotalText)
    if (orderTotal === null) {
      failUnmatched('订单金额为空或无法解析')
      continue
    }
    const afterTotal = afterSalesperson.filter(
      (row) => roundToScale(Number(row.order_total_amount), 2) === roundToScale(orderTotal, 2),
    )
    if (afterTotal.length === 0) {
      failUnmatched(
        `订单金额不符（系统 ${afterSalesperson[0].order_total_amount} / 导入 ${orderTotal}）`,
      )
      continue
    }
    if (afterTotal.length > 1) {
      failUnmatched(`匹配到 ${afterTotal.length} 条成本行，无法唯一定位，请在系统内手动修改`)
      continue
    }

    const target = afterTotal[0]
    entry.itemIds = target.item_ids
    entry.systemCost = target.cost
    entry.currency = target.currency
    entry.matchedQuantity = Number(target.quantity)
    entry.matchedSalesperson = target.salesperson_name
    entry.matchedOrderTotal = Number(target.order_total_amount)

    // 分类：导入成本为空→跳过；系统为空→自动填入；相同→跳过(已一致)；不同→冲突。
    if (importedCost === null) {
      entry.category = 'skipped'
      entry.skipKind = 'empty'
      entry.reason = '导入成本为空，跳过（不改动系统现有成本）'
      result.skipped.push(entry)
    } else if (target.cost === null) {
      entry.category = 'autoFill'
      entry.reason = ''
      result.autoFill.push(entry)
    } else if (roundToScale(target.cost, 4) === roundToScale(importedCost, 4)) {
      entry.category = 'skipped'
      entry.skipKind = 'consistent'
      entry.reason = `与系统当前成本 ${target.cost} 一致，无需改动`
      result.skipped.push(entry)
    } else {
      entry.category = 'conflict'
      entry.reason = `系统已有成本 ${target.cost}，与导入 ${importedCost} 不一致`
      result.conflicts.push(entry)
    }
  }

  return result
}
