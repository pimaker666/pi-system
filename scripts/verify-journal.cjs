const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const ExcelJS = require('exceljs')
const root = path.resolve(__dirname, '..')

function load(relative, mocks = {}) {
  const filename = path.join(root, relative)
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)((name) => {
    if (name in mocks) return mocks[name]
    return require(name)
  }, module, module.exports)
  return module.exports
}

async function main() {
  const shared = load('src/lib/finance-journal.ts')
  const server = load('src/lib/finance-journal-server.ts', { '@/lib/finance-journal': shared })
  assert.deepEqual(shared.journalMonthRange('2024-02'), { from: '2024-02-01', to: '2024-02-29' })
  assert.deepEqual(shared.journalMonthRange('2026-12'), { from: '2026-12-01', to: '2026-12-31' })
  assert.equal(shared.journalMonthRange('2026-13'), null)
  for (const filters of [{ from: '2026-02-30' }, { from: '2026-03-01', to: '2026-02-01' }, { kind: 'invalid' }, { account: 'invalid' }]) {
    assert.equal(shared.journalFiltersSchema.safeParse(filters).success, false)
  }
  const account = { id: '10000000-0000-4000-8000-000000000001', name: '招行', currency: 'CNY', initial_balance: 1000 }
  const otherAccount = { id: '10000000-0000-4000-8000-000000000002', name: '美元户', currency: 'USD', initial_balance: 20 }
  const category = '20000000-0000-4000-8000-000000000001'
  const rows = Array.from({ length: 2505 }, (_, i) => ({
    id: `30000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    account_id: account.id, category_id: category, entry_date: i < 2400 ? '2026-01-01' : '2026-09-01',
    created_at: `2026-01-01T00:00:${String(i).padStart(4, '0')}`, kind: 'expense',
    amount_original: 0.1234, amount_cny: 0.1234, currency: 'CNY', exchange_rate_to_cny: 1,
    summary: '办公室报销', shop: '办公室', reimbursee: '小杨', counterparty: '商家', reference_no: 'REF',
    remark: '', voided_at: i === 2504 ? '2026-10-01' : null, void_reason: '重复',
    account: { id: account.id, name: account.name, currency: account.currency },
    category: { id: category, name: '办公费', kind: 'expense' }, creator: null,
  }))
  const usdRow = { ...rows[2500], id: '30000000-0000-4000-8000-000000009999', account_id: otherAccount.id,
    kind: 'income', amount_original: 10, amount_cny: 70, currency: 'USD', exchange_rate_to_cny: 7,
    account: { id: otherAccount.id, name: otherAccount.name, currency: otherAccount.currency } }
  rows.push(usdRow)
  const calls = []
  const supabase = { from(table) {
    const source = table === 'finance_journal_accounts' ? [account, otherAccount] : rows
    const query = { select() { return this }, order() { return this }, async range(from, to) {
      calls.push({ table, from, to })
      return { data: source.slice(from, Math.min(to + 1, from + 73)), error: null }
    } }
    return query
  } }
  const data = await server.fetchJournalData(supabase)
  assert.equal(data.entries.length, 2506)
  assert.equal(data.runningBalances[rows[2503].id], Number((1000 - 2504 * 0.1234).toFixed(4)))
  assert.equal(data.runningBalances[rows[2504].id], undefined)
  assert.equal(data.runningBalances[usdRow.id], 30)
  assert.ok(calls.filter((call) => call.table === 'finance_journal_entries').length > 30)
  await assert.rejects(() => server.fetchAllJournalRows(async () => ({ data: null, error: { message: 'failed page' } })), /failed page/)
  const filters = shared.journalFiltersSchema.parse({ ...shared.journalMonthRange('2026-09'), account: account.id,
    category, kind: 'expense', reimbursee: '小杨', shop: '办公室', keyword: 'ref', status: 'normal' })
  const matched = shared.filterJournalEntries(data.entries, filters)
  assert.equal(matched.length, 104)
  assert.equal(shared.filterJournalEntries(data.entries, { ...filters, keyword: '无匹配' }).length, 0)
  const allTotals = shared.journalTotals(rows)
  assert.equal(allTotals.voided, 1)
  assert.equal(allTotals.income, 70)
  assert.ok(Math.abs(allTotals.expense - 2504 * 0.1234) < 1e-8)
  let authChecks = 0
  let failLoad = false
  const route = load('src/app/api/finance/journal/export/xlsx/route.ts', {
    '@/lib/auth': { requireFinanceView: async () => { authChecks += 1 } },
    '@/lib/daily-order-costs-server': { chinaToday: () => '2026-10-27' },
    '@/lib/finance': { FINANCE_TRANSACTION_LABELS: { income: '收入', expense: '支出' } },
    '@/lib/finance-journal': shared,
    '@/lib/finance-journal-server': { fetchJournalData: async () => { if (failLoad) throw new Error('private DB error'); return data } },
    '@/lib/supabase/server': { createClient: async () => supabase },
    '@/lib/utils': { displayProfileName: () => '财务', formatDate: (value) => value },
  })
  const post = (body) => route.POST(new Request('http://localhost/api/finance/journal/export/xlsx', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }))
  const response = await post({ filters })
  assert.equal(response.status, 200)
  assert.ok(decodeURIComponent(response.headers.get('content-disposition')).includes('2026-09'))
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()))
  const sheet = workbook.getWorksheet('财务日记账')
  assert.equal(sheet.rowCount, 105)
  assert.equal(sheet.getCell('O2').value, data.runningBalances[matched[0].id])
  assert.equal(sheet.getCell('N2').numFmt, '#,##0.00##')
  assert.ok(workbook.getWorksheet('汇总与筛选'))
  assert.equal(workbook.getWorksheet('账户收支汇总').rowCount, 2)
  const allResponse = await post({ filters: {} })
  const allWorkbook = new ExcelJS.Workbook()
  await allWorkbook.xlsx.load(Buffer.from(await allResponse.arrayBuffer()))
  assert.equal(allWorkbook.getWorksheet('财务日记账').rowCount, 2507)
  assert.equal(allWorkbook.getWorksheet('账户收支汇总').rowCount, 3)
  const duplicate = await post({ ids: [rows[0].id, rows[0].id] })
  const selected = new ExcelJS.Workbook()
  await selected.xlsx.load(Buffer.from(await duplicate.arrayBuffer()))
  assert.equal(selected.getWorksheet('财务日记账').rowCount, 2)
  for (const body of [null, {}, { ids: [] }, { ids: [123] }, { ids: ['bad-id'] }, { filters, ids: [rows[0].id] },
    { filters: { keyword: '无匹配' } }, { filters: { from: '2026-02-30' } }]) {
    assert.equal((await post(body)).status, 400)
  }
  assert.equal((await route.GET(new Request('http://localhost/api/finance/journal/export/xlsx?month=2026-09'))).status, 200)
  assert.equal((await route.GET(new Request('http://localhost/api/finance/journal/export/xlsx?month=2026-13'))).status, 400)
  assert.equal((await route.GET(new Request(`http://localhost/api/finance/journal/export/xlsx?ids=${rows[0].id}&kind=expense`))).status, 400)
  failLoad = true
  const failed = await post({ filters })
  assert.equal(failed.status, 500)
  assert.equal((await failed.json()).error.includes('private DB error'), false)
  assert.ok(authChecks >= 14)
  console.log('PASS: 月份/组合筛选、2506条分页完整性、历史结余、XLSX汇总与4位精度、空/非法请求、查询失败、导出鉴权入口')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
