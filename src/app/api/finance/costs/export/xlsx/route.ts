import ExcelJS from 'exceljs'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { requireFinanceAccess } from '@/lib/auth'
import { fetchBusinessOrderProductCosts } from '@/lib/business-order-costs-server'
import { chinaToday } from '@/lib/daily-order-costs-server'
import { formatDailyMoney, PAYMENT_LABELS, SHIPPING_LABELS } from '@/lib/daily-orders'
import { FINANCE_COST_LABELS } from '@/lib/finance'
import { createClient } from '@/lib/supabase/server'
import { parseBusinessOrderCostFilters } from '@/lib/business-order-cost'
import type { FinanceOrderCost } from '@/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function styleHeader(row: ExcelJS.Row) {
  row.height = 24
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })
}

function styleBody(row: ExcelJS.Row) {
  row.alignment = { vertical: 'middle', wrapText: true }
  row.eachCell((cell) => {
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
  })
}

const PAGE_SIZE = 1000

function searchParamsToRecord(searchParams: URLSearchParams): Record<string, string | string[]> {
  const raw: Record<string, string | string[]> = {}
  searchParams.forEach((value, key) => {
    const existing = raw[key]
    if (existing === undefined) {
      raw[key] = value
    } else {
      raw[key] = Array.isArray(existing) ? [...existing, value] : [existing, value]
    }
  })
  return raw
}

async function fetchAllFinanceCosts(supabase: Awaited<ReturnType<typeof createClient>>) {
  const rows: FinanceOrderCost[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('finance_order_costs')
      .select('*')
      .order('incurred_date', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`其他订单费用读取失败：${error.message}`)
    const page = (data ?? []) as FinanceOrderCost[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

async function fetchAllLegacyReferences(supabase: Awaited<ReturnType<typeof createClient>>) {
  const rows: Array<{ id: string; pi_number_snapshot: string }> = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('finance_orders')
      .select('id, pi_number_snapshot')
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`历史 PI 引用读取失败：${error.message}`)
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

async function fetchAllBusinessReferences(supabase: Awaited<ReturnType<typeof createClient>>) {
  const rows: Array<{ id: string; order_number: string }> = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('business_orders')
      .select('id, order_number')
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`业务订单引用读取失败：${error.message}`)
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

export async function GET(request: NextRequest) {
  await requireFinanceAccess()
  const supabase = await createClient()
  const filters = parseBusinessOrderCostFilters(searchParamsToRecord(request.nextUrl.searchParams))

  const [dailyResult, costs, legacyOrders, businessOrders] = await Promise.all([
    fetchBusinessOrderProductCosts(supabase, filters, 1, 500),
    fetchAllFinanceCosts(supabase),
    fetchAllLegacyReferences(supabase),
    fetchAllBusinessReferences(supabase),
  ])
  const dailyCosts = dailyResult.rows

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'PI System'

  const dailySheet = workbook.addWorksheet('业务订单产品成本', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })
  dailySheet.columns = [
    10, 13, 20, 16, 24, 13, 20, 12, 26, 14, 16, 16, 18, 16, 18, 16, 18, 16, 12, 32, 14,
  ].map((width) => ({ width }))
  styleHeader(dailySheet.addRow([
    '序号', '下单日期', '店铺', '业务员', '订单号', '发货日期', '收款账户', '发货分类',
    '产品名称', '数量', '成本', '总成本', '发货进度', '销售单价', '产品实收金额', '运费实收金额',
    '订单总金额', '未收尾款', '收款分类', '备注', '截图数',
  ]))

  dailyCosts.forEach((item, index) => {
    const row = dailySheet.addRow([
      item.product_name === '—' ? `${index + 1}-无明细` : index + 1,
      item.order_date,
      item.shop_name ?? '',
      item.salesperson_name,
      item.external_order_number || item.order_number,
      item.shipping_date ?? '',
      item.payment_account || item.shipping_number || '',
      item.shipping_category ? SHIPPING_LABELS[item.shipping_category] : '',
      `${item.product_name}${item.product_sku ? `\n${item.product_sku}` : ''}`,
      item.quantity,
      item.cost,
      item.total_cost,
      item.shipping_progress,
      item.unit_price,
      item.product_received_amount,
      item.logistics_fee_amount,
      item.order_total_amount,
      item.outstanding_amount,
      item.payment_category ? PAYMENT_LABELS[item.payment_category] : '',
      item.sales_notes ?? '',
      item.attachments.length,
    ])
    row.getCell(10).numFmt = '0.####'
    row.getCell(11).numFmt = '0.0000'
    row.getCell(12).numFmt = '0.0000'
    row.getCell(14).numFmt = '#,##0.00'
    row.getCell(15).numFmt = '#,##0.00'
    row.getCell(16).numFmt = '#,##0.00'
    row.getCell(17).numFmt = '#,##0.00'
    row.getCell(18).numFmt = '#,##0.00'
    styleBody(row)
  })
  dailySheet.autoFilter = { from: 'A1', to: 'U1' }

  const legacyReferences = new Map(
    legacyOrders.map((order) => [order.id, order.pi_number_snapshot]),
  )
  const businessReferences = new Map(
    businessOrders.map((order) => [order.id, order.order_number]),
  )
  const otherSheet = workbook.addWorksheet('其他订单费用', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })
  otherSheet.columns = [13, 22, 16, 16, 14, 16, 16, 32].map((width) => ({ width }))
  styleHeader(otherSheet.addRow([
    '发生日期', '订单', '成本类型', '原币金额', '币种', '兑人民币汇率', '折合人民币', '备注',
  ]))

  costs.forEach((cost) => {
    const reference = cost.business_order_id
      ? businessReferences.get(cost.business_order_id)
      : cost.finance_order_id
        ? legacyReferences.get(cost.finance_order_id)
        : undefined
    const row = otherSheet.addRow([
      cost.incurred_date,
      reference ?? '订单已不可用',
      FINANCE_COST_LABELS[cost.cost_type],
      Number(cost.amount_original),
      cost.currency,
      Number(cost.exchange_rate_to_cny),
      Number(cost.amount_cny),
      cost.description ?? '',
    ])
    row.getCell(4).numFmt = '#,##0.00'
    row.getCell(6).numFmt = '0.00000000'
    row.getCell(7).numFmt = '¥#,##0.00'
    styleBody(row)
  })
  otherSheet.autoFilter = { from: 'A1', to: 'H1' }

  const buffer = await workbook.xlsx.writeBuffer()
  const body = new Uint8Array(buffer as ArrayBuffer)
  const date = chinaToday()
  const fileName = `全部订单成本表_${date}.xlsx`
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="all-order-costs-${date}.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Content-Length': String(body.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
