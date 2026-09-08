import ExcelJS from 'exceljs'
import { NextResponse } from 'next/server'
import { requireFinanceAccess } from '@/lib/auth'
import { chinaToday, fetchDailyOrderProductCosts } from '@/lib/daily-order-costs-server'
import { SHIPPING_LABELS } from '@/lib/daily-orders'
import { FINANCE_COST_LABELS } from '@/lib/finance'
import { createClient } from '@/lib/supabase/server'
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

export async function GET() {
  await requireFinanceAccess()
  const supabase = await createClient()
  const [dailyCosts, costs, legacyOrders, businessOrders] = await Promise.all([
    fetchDailyOrderProductCosts(supabase),
    fetchAllFinanceCosts(supabase),
    fetchAllLegacyReferences(supabase),
    fetchAllBusinessReferences(supabase),
  ])

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'PI System'

  const dailySheet = workbook.addWorksheet('已发货每日订单成本', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })
  dailySheet.columns = [13, 13, 20, 16, 16, 26, 18, 12, 16, 22, 22, 16].map((width) => ({ width }))
  styleHeader(dailySheet.addRow([
    '发货日期', '下单日期', '订单号', '店铺', '业务员', '销售产品', '销售 SKU',
    '发货分类', '数量', '财务编号', '财务产品名称', '成本',
  ]))

  dailyCosts.forEach((item) => {
    const row = dailySheet.addRow([
      item.shipping_date,
      item.order_date,
      item.order_number,
      item.shop_name,
      item.salesperson_name,
      item.sales_product_name,
      item.sales_product_sku,
      SHIPPING_LABELS[item.shipping_category],
      item.quantity,
      item.financial_number ?? '',
      item.financial_product_name ?? '',
      item.cost,
    ])
    row.getCell(9).numFmt = '0.####'
    row.getCell(12).numFmt = '¥#,##0.0000'
    styleBody(row)
  })
  dailySheet.autoFilter = { from: 'A1', to: 'L1' }

  const legacyReferences = new Map(
    legacyOrders.map((order) => [order.id, order.pi_number_snapshot]),
  )
  const businessReferences = new Map(
    businessOrders.map((order) => [order.id, order.order_number]),
  )
  const otherSheet = workbook.addWorksheet('其他订单费用', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })
  otherSheet.columns = [13, 22, 16, 16, 14, 16, 16, 12, 32, 32].map((width) => ({ width }))
  styleHeader(otherSheet.addRow([
    '发生日期', '订单', '成本类型', '原币金额', '币种', '兑人民币汇率', '折合人民币',
    '状态', '备注', '作废原因',
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
      cost.status === 'void' ? '已作废' : '有效',
      cost.description ?? '',
      cost.void_reason ?? '',
    ])
    row.getCell(4).numFmt = '#,##0.00'
    row.getCell(6).numFmt = '0.00000000'
    row.getCell(7).numFmt = '¥#,##0.00'
    styleBody(row)
  })
  otherSheet.autoFilter = { from: 'A1', to: 'J1' }

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
