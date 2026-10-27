import ExcelJS from 'exceljs'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireFinanceView } from '@/lib/auth'
import { chinaToday } from '@/lib/daily-order-costs-server'
import { FINANCE_TRANSACTION_LABELS } from '@/lib/finance'
import { DEFAULT_JOURNAL_FILTERS, filterJournalEntries, journalFiltersSchema, journalMonthRange, journalTotals } from '@/lib/finance-journal'
import { fetchJournalData } from '@/lib/finance-journal-server'
import { createClient } from '@/lib/supabase/server'
import { displayProfileName, formatDate } from '@/lib/utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const exportSchema = z.object({
  filters: journalFiltersSchema.optional(),
  ids: z.array(z.string().uuid()).min(1).max(100000).optional(),
}).strict().refine((value) => Boolean(value.filters) !== Boolean(value.ids), '请选择筛选条件或有效的分录 ID')

const EXPORT_COLUMNS = [
  '日期', '账户', '类型', '分类', '摘要', '收/付款人', '报销人', '店铺', '流水号', '备注',
  '币种', '原币金额', '兑人民币汇率', '折合人民币', '结余(原币)', '登记人', '状态', '作废原因',
]

async function buildXlsxResponse(input: unknown) {
  const parsed = exportSchema.safeParse(input)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? '导出条件无效' }, { status: 400 })
  }
  const filters = parsed.data.filters ?? DEFAULT_JOURNAL_FILTERS
  let data
  try {
    data = await fetchJournalData(await createClient())
  } catch {
    return NextResponse.json({ error: '读取日记账失败，请稍后重试' }, { status: 500 })
  }
  const selectedIds = parsed.data.ids ? new Set(parsed.data.ids) : null
  const entries = selectedIds
    ? data.entries.filter((entry) => selectedIds.has(entry.id))
    : filterJournalEntries(data.entries, filters)
  if (entries.length === 0) {
    return NextResponse.json({ error: '当前筛选范围没有可导出的日记账记录' }, { status: 400 })
  }
  const totals = journalTotals(entries)
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'PI System'
  const sheet = workbook.addWorksheet('财务日记账', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [12, 20, 8, 18, 32, 20, 14, 14, 20, 24, 8, 16, 16, 16, 16, 14, 8, 24].map((width) => ({ width }))
  const header = sheet.addRow(EXPORT_COLUMNS)
  header.height = 24
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })

  for (const entry of entries) {
    const row = sheet.addRow([
      formatDate(entry.entry_date), entry.account?.name ?? '', FINANCE_TRANSACTION_LABELS[entry.kind],
      entry.category?.name ?? '', entry.summary, entry.counterparty ?? '', entry.reimbursee ?? '',
      entry.shop ?? '', entry.reference_no ?? '', entry.remark ?? '', entry.currency,
      Number(entry.amount_original), Number(entry.exchange_rate_to_cny), Number(entry.amount_cny),
      entry.voided_at ? null : data.runningBalances[entry.id], displayProfileName(entry.creator),
      entry.voided_at ? '已作废' : '正常', entry.voided_at ? entry.void_reason ?? '' : '',
    ])
    row.alignment = { vertical: 'middle', wrapText: true }
    row.eachCell((cell) => { cell.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } } })
    for (const column of [12, 14, 15]) row.getCell(column).numFmt = '#,##0.00##'
    row.getCell(13).numFmt = '0.00000000'
    if (entry.voided_at) row.font = { color: { argb: 'FF9CA3AF' } }
  }
  sheet.autoFilter = { from: 'A1', to: `R${entries.length + 1}` }

  const summary = workbook.addWorksheet('汇总与筛选')
  summary.columns = [{ width: 28 }, { width: 72 }]
  const selectedAccount = entries.find((entry) => entry.account_id === filters.account)?.account?.name
  const selectedCategory = entries.find((entry) => entry.category_id === filters.category)?.category?.name
  const scope = selectedIds ? `指定分录（${entries.length} 条）` : `${filters.from || '不限'} 至 ${filters.to || '不限'}`
  for (const values of [
    ['导出范围', scope],
    ['账户', filters.account === 'all' ? '全部账户' : selectedAccount ?? filters.account],
    ['收支类型', filters.kind === 'all' ? '全部类型' : FINANCE_TRANSACTION_LABELS[filters.kind]],
    ['分类', filters.category === 'all' ? '全部分类' : selectedCategory ?? filters.category],
    ['状态', { all: '全部状态', normal: '正常', voided: '已作废' }[filters.status]],
    ['店铺', filters.shop === 'all' ? '全部店铺' : filters.shop],
    ['报销人', filters.reimbursee === 'all' ? '全部报销人' : filters.reimbursee],
    ['关键词', filters.keyword || '不限'],
    ['记录数', entries.length], ['正常记录数', totals.normal], ['作废记录数', totals.voided],
    ['收入合计（CNY）', totals.income], ['支出合计（CNY）', totals.expense], ['净收支（CNY）', totals.net],
    ['汇总口径', '仅统计正常流水；不含期初余额，不混加不同币种的原币金额。'],
    ['逐行结余口径', '账户期初 + 全部历史收入 − 全部历史支出；排除作废，不受本次筛选影响。'],
    ['导出日期', chinaToday()],
  ]) {
    const row = summary.addRow(values)
    row.alignment = { vertical: 'middle', wrapText: true }
    row.getCell(1).font = { bold: true }
    if (typeof values[1] === 'number' && String(values[0]).includes('CNY')) row.getCell(2).numFmt = '#,##0.00##'
  }

  const accountSheet = workbook.addWorksheet('账户收支汇总', { views: [{ state: 'frozen', ySplit: 1 }] })
  accountSheet.columns = [24, 12, 18, 18, 18, 18, 18].map((width) => ({ width }))
  accountSheet.addRow(['账户', '账户币种', '收入（原币）', '支出（原币）', '净收支（原币）', '收入（CNY）', '支出（CNY）']).font = { bold: true }
  for (const account of data.accounts) {
    const rows = entries.filter((entry) => entry.account_id === account.id && !entry.voided_at)
    if (!rows.length) continue
    const income = rows.filter((row) => row.kind === 'income').reduce((sum, row) => sum + Number(row.amount_original), 0)
    const expense = rows.filter((row) => row.kind === 'expense').reduce((sum, row) => sum + Number(row.amount_original), 0)
    const accountTotals = journalTotals(rows)
    const row = accountSheet.addRow([account.name, account.currency, income, expense, income - expense, accountTotals.income, accountTotals.expense])
    for (const column of [3, 4, 5, 6, 7]) row.getCell(column).numFmt = '#,##0.00##'
  }

  const buffer = await workbook.xlsx.writeBuffer()
  const body = new Uint8Array(buffer as ArrayBuffer)
  const month = filters.from && journalMonthRange(filters.from.slice(0, 7))
  const fileScope = month && month.from === filters.from && month.to === filters.to
    ? filters.from.slice(0, 7) : filters.from || filters.to
      ? `${filters.from || '不限'}至${filters.to || '不限'}` : chinaToday()
  const fileName = `财务日记账_${fileScope}.xlsx`
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="finance-journal-${chinaToday()}.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Content-Length': String(body.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export async function GET(request: Request) {
  await requireFinanceView()
  const params = new URL(request.url).searchParams
  if (params.has('ids')) {
    if ([...params.keys()].some((key) => key !== 'ids')) {
      return NextResponse.json({ error: '分录 ID 与筛选条件不能混用' }, { status: 400 })
    }
    return buildXlsxResponse({ ids: params.getAll('ids').flatMap((value) => value.split(',').map((id) => id.trim())) })
  }
  const filters = Object.fromEntries(params)
  if (params.has('month')) {
    const range = journalMonthRange(params.get('month')!)
    if (!range || params.has('from') || params.has('to')) {
      return NextResponse.json({ error: '月份无效或与日期范围冲突' }, { status: 400 })
    }
    delete filters.month
    Object.assign(filters, range)
  }
  return buildXlsxResponse({ filters })
}

export async function POST(request: Request) {
  await requireFinanceView()
  const body: unknown = await request.json().catch(() => null)
  return buildXlsxResponse(body)
}
