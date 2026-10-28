import type { Row, Worksheet } from 'exceljs'
import type { FinanceJournalEntry } from '@/types'
import { FINANCE_TRANSACTION_LABELS } from '@/lib/finance'
import { displayProfileName, formatDate } from '@/lib/utils'

function chinaToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

export interface OverviewMonthStat {
  month: string
  income: number
  expense: number
  net: number
}

export interface OverviewCategorySum {
  name: string
  kind: 'income' | 'expense'
  amount: number
}

export interface OverviewAccountRow {
  name: string
  currency: string
  incomeOriginal: number
  expenseOriginal: number
  incomeCny: number
  expenseCny: number
}

export interface OverviewReimburseeRow {
  name: string
  amount: number
}

export interface JournalOverviewExportInput {
  scopeLabel: string
  accountLabel: string
  from: string
  to: string
  months: OverviewMonthStat[]
  totals: { income: number; expense: number; net: number; normal: number; voided: number }
  openingBalanceCny: number
  closingBalanceCny: number
  categories: OverviewCategorySum[]
  accounts: OverviewAccountRow[]
  reimbursees: OverviewReimburseeRow[]
  runningBalances: Record<string, number>
  entriesByMonth: Map<string, FinanceJournalEntry[]>
}

const DETAIL_COLUMNS = [
  '日期', '账户', '类型', '分类', '摘要', '收/付款人', '报销人', '店铺', '流水号', '备注',
  '币种', '原币金额', '兑人民币汇率', '折合人民币', '结余(原币)', '登记人', '状态', '作废原因',
]

const MONEY_FMT = '#,##0.00##'
const RATE_FMT = '0.00000000'

function styleHeader(row: Row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })
}

function addSummaryBlock(sheet: Worksheet, title: string) {
  const row = sheet.addRow([title])
  row.getCell(1).font = { bold: true, size: 12 }
  row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } }
}

export async function exportJournalOverview(input: JournalOverviewExportInput): Promise<void> {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'PI System'

  const summary = workbook.addWorksheet('总览')
  summary.columns = [{ width: 26 }, { width: 30 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }]

  addSummaryBlock(summary, '导出信息')
  for (const [label, value] of [
    ['统计范围', input.scopeLabel],
    ['起止日期', `${input.from} 至 ${input.to}`],
    ['账户', input.accountLabel],
    ['口径', '排除作废；金额折 CNY；余额按各币种最近流水汇率折算估算'],
    ['导出日期', chinaToday()],
  ] as const) {
    const row = summary.addRow([label, value])
    row.getCell(1).font = { bold: true }
    row.alignment = { vertical: 'middle', wrapText: true }
  }

  addSummaryBlock(summary, '收支汇总')
  const monthCount = Math.max(1, input.months.length)
  for (const [label, value, isMoney] of [
    ['收入合计（CNY）', input.totals.income, true],
    ['支出合计（CNY）', input.totals.expense, true],
    ['净收支（CNY）', input.totals.net, true],
    ['月均收入（CNY）', input.totals.income / monthCount, true],
    ['月均支出（CNY）', input.totals.expense / monthCount, true],
    ['区间期初余额（CNY 估算）', input.openingBalanceCny, true],
    ['区间期末余额（CNY 估算）', input.closingBalanceCny, true],
    ['正常记录数', input.totals.normal, false],
    ['作废记录数（未计入收支）', input.totals.voided, false],
  ] as const) {
    const row = summary.addRow([label, value])
    row.getCell(1).font = { bold: true }
    if (isMoney) row.getCell(2).numFmt = MONEY_FMT
  }

  addSummaryBlock(summary, '月度收支表')
  const monthHeader = summary.addRow(['月份', '', '收入（CNY）', '支出（CNY）', '净额（CNY）'])
  styleHeader(monthHeader)
  for (const month of input.months) {
    const row = summary.addRow([month.month, '', month.income, month.expense, month.net])
    for (const column of [3, 4, 5]) row.getCell(column).numFmt = MONEY_FMT
  }
  const monthTotal = summary.addRow([
    '合计', '', input.totals.income, input.totals.expense, input.totals.net,
  ])
  monthTotal.font = { bold: true }
  for (const column of [3, 4, 5]) monthTotal.getCell(column).numFmt = MONEY_FMT

  addSummaryBlock(summary, '分类汇总')
  const categoryHeader = summary.addRow(['分类', '类型', '金额（CNY）', '占比', ''])
  styleHeader(categoryHeader)
  const categoryTotal = input.categories.reduce((sum, item) => sum + item.amount, 0)
  for (const item of input.categories) {
    const row = summary.addRow([
      item.name, FINANCE_TRANSACTION_LABELS[item.kind], item.amount,
      categoryTotal > 0 ? item.amount / categoryTotal : 0, '',
    ])
    row.getCell(3).numFmt = MONEY_FMT
    row.getCell(4).numFmt = '0.0%'
  }

  addSummaryBlock(summary, '账户汇总')
  const accountHeader = summary.addRow(['账户', '币种', '收入（原币）', '支出（原币）', '收入（CNY）', '支出（CNY）', '净额（CNY）'])
  styleHeader(accountHeader)
  for (const account of input.accounts) {
    const row = summary.addRow([
      account.name, account.currency, account.incomeOriginal, account.expenseOriginal,
      account.incomeCny, account.expenseCny, account.incomeCny - account.expenseCny,
    ])
    row.getCell(3).numFmt = MONEY_FMT
    row.getCell(4).numFmt = MONEY_FMT
    for (const column of [5, 6, 7]) row.getCell(column).numFmt = MONEY_FMT
  }

  addSummaryBlock(summary, '报销人汇总（支出）')
  const reimburseeHeader = summary.addRow(['报销人', '支出（CNY）', '占总支出比', '', ''])
  styleHeader(reimburseeHeader)
  for (const reimbursee of input.reimbursees) {
    const row = summary.addRow([
      reimbursee.name, reimbursee.amount,
      input.totals.expense > 0 ? reimbursee.amount / input.totals.expense : 0, '', '',
    ])
    row.getCell(2).numFmt = MONEY_FMT
    row.getCell(3).numFmt = '0.0%'
  }

  for (const [month, entries] of input.entriesByMonth) {
    const sheet = workbook.addWorksheet(month, { views: [{ state: 'frozen', ySplit: 1 }] })
    sheet.columns = [12, 20, 8, 18, 32, 20, 14, 14, 20, 24, 8, 16, 16, 16, 16, 14, 8, 24].map((width) => ({ width }))
    styleHeader(sheet.addRow(DETAIL_COLUMNS))
    for (const entry of entries) {
      const row = sheet.addRow([
        formatDate(entry.entry_date), entry.account?.name ?? '', FINANCE_TRANSACTION_LABELS[entry.kind],
        entry.category?.name ?? '', entry.summary, entry.counterparty ?? '', entry.reimbursee ?? '',
        entry.shop ?? '', entry.reference_no ?? '', entry.remark ?? '', entry.currency,
        Number(entry.amount_original), Number(entry.exchange_rate_to_cny), Number(entry.amount_cny),
        entry.voided_at ? null : input.runningBalances[entry.id] ?? null,
        displayProfileName(entry.creator),
        entry.voided_at ? '已作废' : '正常', entry.voided_at ? entry.void_reason ?? '' : '',
      ])
      row.alignment = { vertical: 'middle', wrapText: true }
      for (const column of [12, 14]) row.getCell(column).numFmt = MONEY_FMT
      row.getCell(13).numFmt = RATE_FMT
      if (entry.voided_at) {
        row.font = { color: { argb: 'FF9CA3AF' }, strike: true }
        row.getCell(15).value = null
      }
    }
    sheet.autoFilter = { from: 'A1', to: `R${Math.max(1, entries.length + 1)}` }
  }

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `日记账总览_${input.scopeLabel}.xlsx`
  anchor.click()
  URL.revokeObjectURL(url)
}
