import ExcelJS from 'exceljs'
import { NextResponse } from 'next/server'
import { requireFinanceView } from '@/lib/auth'
import { FINANCE_TRANSACTION_LABELS } from '@/lib/finance'
import { createClient } from '@/lib/supabase/server'
import { displayProfileName, formatDate } from '@/lib/utils'
import type { FinanceJournalEntry } from '@/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LIST_LIMIT = 2000
const IDS_CHUNK = 100
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const EXPORT_COLUMNS = [
  '日期',
  '账户',
  '类型',
  '分类',
  '摘要',
  '收/付款人',
  '报销人',
  '店铺',
  '流水号',
  '备注',
  '币种',
  '原币金额',
  '兑人民币汇率',
  '折合人民币',
  '结余(原币)',
  '登记人',
  '状态',
  '作废原因',
]

type JournalEntryRow = Pick<
  FinanceJournalEntry,
  | 'id'
  | 'entry_date'
  | 'kind'
  | 'amount_original'
  | 'currency'
  | 'exchange_rate_to_cny'
  | 'amount_cny'
  | 'summary'
  | 'counterparty'
  | 'reference_no'
  | 'reimbursee'
  | 'shop'
  | 'remark'
  | 'voided_at'
  | 'void_reason'
> & {
  account: { name: string } | null
  category: { name: string } | null
  creator: { chinese_name: string | null; full_name: string | null; email: string | null } | null
}

function parseIds(values: string[]): string[] {
  return values
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => UUID_RE.test(v))
}

async function fetchEntries(ids?: string[]): Promise<JournalEntryRow[]> {
  const supabase = await createClient()
  const select =
    'id, entry_date, kind, amount_original, currency, exchange_rate_to_cny, amount_cny, summary, counterparty, reference_no, reimbursee, shop, remark, voided_at, void_reason, account:finance_journal_accounts(name), category:finance_journal_categories(name), creator:profiles!finance_journal_entries_created_by_fkey(chinese_name, full_name, email)'

  if (!ids || ids.length === 0) {
    const { data, error } = await supabase
      .from('finance_journal_entries')
      .select(select)
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(LIST_LIMIT)
    if (error) throw new Error(error.message)
    return (data ?? []) as unknown as JournalEntryRow[]
  }

  const rows: JournalEntryRow[] = []
  for (let index = 0; index < ids.length; index += IDS_CHUNK) {
    const chunk = ids.slice(index, index + IDS_CHUNK)
    const { data, error } = await supabase
      .from('finance_journal_entries')
      .select(select)
      .in('id', chunk)
    if (error) throw new Error(error.message)
    rows.push(...((data ?? []) as unknown as JournalEntryRow[]))
  }
  return rows
}

// 逐行结余：全量未作废历史按日期正序累计（期初+收入−支出，原币口径，排除作废）
async function fetchRunningBalances(): Promise<Map<string, number>> {
  const supabase = await createClient()
  const [{ data: accounts }, { data: history }] = await Promise.all([
    supabase.from('finance_journal_accounts').select('id, initial_balance'),
    supabase
      .from('finance_journal_entries')
      .select('id, account_id, entry_date, created_at, kind, amount_original, voided_at')
      .order('entry_date')
      .order('created_at'),
  ])
  const balanceMap = new Map<string, number>()
  const accBalance = new Map<string, number>(
    ((accounts ?? []) as { id: string; initial_balance: number }[]).map((account) => [
      account.id,
      Number(account.initial_balance),
    ]),
  )
  for (const row of (history ?? []) as {
    id: string
    account_id: string
    kind: 'income' | 'expense'
    amount_original: number
    voided_at: string | null
  }[]) {
    if (row.voided_at) continue
    const next =
      (accBalance.get(row.account_id) ?? 0) +
      (row.kind === 'income' ? Number(row.amount_original) : -Number(row.amount_original))
    accBalance.set(row.account_id, next)
    balanceMap.set(row.id, next)
  }
  return balanceMap
}

async function buildXlsxResponse(ids?: string[]) {
  let entries: JournalEntryRow[]
  let runningBalances: Map<string, number>
  try {
    ;[entries, runningBalances] = await Promise.all([fetchEntries(ids), fetchRunningBalances()])
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '读取日记账失败' },
      { status: 500 },
    )
  }

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'PI System'
  const sheet = workbook.addWorksheet('财务日记账', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [12, 20, 8, 14, 32, 20, 10, 12, 20, 24, 8, 14, 14, 14, 14, 14, 8, 24].map((width) => ({ width }))
  const header = sheet.addRow(EXPORT_COLUMNS)
  header.height = 24
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })

  for (const entry of entries) {
    const row = sheet.addRow([
      formatDate(entry.entry_date),
      entry.account?.name ?? '',
      FINANCE_TRANSACTION_LABELS[entry.kind],
      entry.category?.name ?? '',
      entry.summary,
      entry.counterparty ?? '',
      entry.reimbursee ?? '',
      entry.shop ?? '',
      entry.reference_no ?? '',
      entry.remark ?? '',
      entry.currency,
      Number(entry.amount_original),
      Number(entry.exchange_rate_to_cny),
      Number(entry.amount_cny),
      entry.voided_at ? null : (runningBalances.get(entry.id) ?? null),
      displayProfileName(entry.creator),
      entry.voided_at ? '已作废' : '正常',
      entry.voided_at ? (entry.void_reason ?? '') : '',
    ])
    row.alignment = { vertical: 'middle', wrapText: true }
    row.eachCell((cell) => {
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
    })
    if (entry.voided_at) {
      row.font = { color: { argb: 'FF9CA3AF' } }
    }
  }

  sheet.autoFilter = { from: 'A1', to: `R1` }
  const buffer = await workbook.xlsx.writeBuffer()
  const body = new Uint8Array(buffer as ArrayBuffer)
  const date = new Date().toISOString().slice(0, 10)
  const fileName = `财务日记账_${date}.xlsx`
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="finance-journal-${date}.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Content-Length': String(body.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export async function GET(request: Request) {
  await requireFinanceView()
  const ids = parseIds(new URL(request.url).searchParams.getAll('ids'))
  return buildXlsxResponse(ids.length > 0 ? ids : undefined)
}

// 批量选中导出走 POST：ids 放请求体，避免超长 URL 被 Kong（~8k）或 Node（16k）拒绝。
export async function POST(request: Request) {
  await requireFinanceView()
  const body = (await request.json().catch(() => null)) as { ids?: string[] } | null
  if (!body) return NextResponse.json({ error: '请求格式错误' }, { status: 400 })
  const ids = parseIds(Array.isArray(body.ids) ? body.ids : [])
  return buildXlsxResponse(ids.length > 0 ? ids : undefined)
}
