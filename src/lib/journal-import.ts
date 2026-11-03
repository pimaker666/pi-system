// 银行流水导入解析器：客户端本地解析，不经过服务端文件上传。
// 支持两种格式：
//   1. 招商银行 CSV（一卡通/私账导出，# 注释头）
//   2. 中国银行对账单粘贴文本（表格折行需合并）

export interface JournalImportParsedRow {
  entry_date: string // YYYY-MM-DD
  kind: 'income' | 'expense'
  amount_original: number
  summary: string
  counterparty?: string
  reference_no?: string
}

function parseAmount(raw: string): number | null {
  const value = Number(raw.replace(/,/g, '').trim())
  return Number.isFinite(value) && value > 0 ? value : null
}

// 部分银行把支出导出为负数或括号形式，符号本身即方向。
function parseSignedAmount(raw: string): number | null {
  const cleaned = raw
    .replace(/[,，\s\u3000]/g, '')
    .replace(/^[(（](.+)[)）]$/, '-$1')
    .replace(/[−–—]/g, '-')
  const value = Number(cleaned)
  return Number.isFinite(value) && value !== 0 ? value : null
}

function ymdFromCompact(raw: string): string | null {
  const digits = raw.trim()
  if (/^\d{8}$/.test(digits)) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
  }
  if (/^\d{6}$/.test(digits)) {
    return `20${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`
  }
  return null
}

// 解析一行 CSV（处理引号包裹与 "" 转义），返回字段数组。
function splitCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else if (char === '"') {
        inQuotes = false
      } else {
        current += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }
  fields.push(current)
  return fields
}

// 招商银行交易记录 CSV：表头「交易日期,交易时间,收入,支出,余额,交易类型,交易备注」，
// 前面若干 # 注释行（账号/币种/日期范围/合计），数据行内字段可能带前导 Tab。
export function parseCmbCsv(text: string): JournalImportParsedRow[] {
  const rows: JournalImportParsedRow[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const fields = splitCsvLine(line)
    const date = ymdFromCompact(fields[0] ?? '')
    if (!date) continue // 表头行或非数据行
    const income = parseAmount(fields[2] ?? '')
    const expense = parseAmount(fields[3] ?? '')
    const summary = (fields[6] ?? '').trim() || (fields[5] ?? '').trim()
    if (!summary) continue
    if (income !== null && expense === null) {
      rows.push({ entry_date: date, kind: 'income', amount_original: income, summary })
    } else if (expense !== null && income === null) {
      rows.push({ entry_date: date, kind: 'expense', amount_original: expense, summary })
    }
  }
  return rows
}

interface BocRow {
  cells: string[]
}

function splitBocCells(line: string): string[] {
  // 折行的单元格内容里也含 | 的概率极低，直接按竖线切分。
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim())
}

function isBocDataStart(line: string): boolean {
  return /^\s*\|\s*\d+\s*\|/.test(line)
}

function isBocContinuation(line: string): boolean {
  return /^\s*\|/.test(line) && !isBocDataStart(line)
}

// 中国银行对账单粘贴文本：
//   数据行以「| 序号 |」开头，折行以「|    |」开头且各单元格内容需拼回上一行同列。
//   列序：序号|记账日|起息日|交易类型|凭证|摘要|借方(支出)|贷方(收入)|余额|流水|备注
export function parseBocStatementText(text: string): JournalImportParsedRow[] {
  const rows: BocRow[] = []
  for (const line of text.split(/\r?\n/)) {
    if (isBocDataStart(line)) {
      rows.push({ cells: splitBocCells(line) })
    } else if (isBocContinuation(line) && rows.length > 0) {
      const cells = splitBocCells(line)
      const last = rows[rows.length - 1]
      for (let i = 0; i < cells.length; i += 1) {
        if (cells[i]) {
          last.cells[i] = (last.cells[i] ?? '') + cells[i]
        }
      }
    }
  }

  const parsed: JournalImportParsedRow[] = []
  for (const row of rows) {
    const date = ymdFromCompact(row.cells[1] ?? '')
    if (!date) continue
    const debit = parseAmount(row.cells[6] ?? '')
    const credit = parseAmount(row.cells[7] ?? '')
    const detail = row.cells[5] ?? ''
    const notes = row.cells[10] ?? ''
    const type = row.cells[3] ?? ''
    const summary = detail || notes || type
    if (!summary) continue
    // 备注列为对方户名（折行已合并）；机构/柜员/流水列取最后一段作为流水号。
    const counterparty = notes.trim() || undefined
    const referenceNo = (row.cells[9] ?? '')
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean)
      .pop()
    if (credit !== null && debit === null) {
      parsed.push({
        entry_date: date,
        kind: 'income',
        amount_original: credit,
        summary,
        counterparty,
        reference_no: referenceNo,
      })
    } else if (debit !== null && credit === null) {
      parsed.push({
        entry_date: date,
        kind: 'expense',
        amount_original: debit,
        summary,
        counterparty,
        reference_no: referenceNo,
      })
    }
  }
  return parsed
}

// ---------------------------------------------------------------------------
// 电子表格（Excel / CSV 导出）导入：按表头识别列，兼容招行与中行的导出模板。
// ---------------------------------------------------------------------------

function pad2(value: number) {
  return String(value).padStart(2, '0')
}

function ymdFromDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

function ymdFromExcelSerial(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 100000) return null
  const date = new Date(Math.round((serial - 25569) * 86400000))
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

// Excel 单元格可能是 Date、数字（日期序列号）、富文本对象或公式结果。
export function statementCellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : ymdFromDate(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'object') {
    const cell = value as {
      richText?: Array<{ text?: string }>
      text?: string
      result?: unknown
    }
    if (Array.isArray(cell.richText)) {
      return cell.richText.map((part) => part.text ?? '').join('').trim()
    }
    if (typeof cell.text === 'string') return cell.text.trim()
    if ('result' in cell) return statementCellText(cell.result)
  }
  return ''
}

function normalizeDateValue(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : ymdFromDate(value)
  }
  if (typeof value === 'number') return ymdFromExcelSerial(value)
  const compact = statementCellText(value).replace(/[\s\u3000]/g, '')
  if (!compact) return null
  const compactYmd = ymdFromCompact(compact)
  if (compactYmd) return compactYmd
  const match = compact.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/)
  if (!match) return null
  return `${match[1]}-${pad2(Number(match[2]))}-${pad2(Number(match[3]))}`
}

// 把 CSV 文本转成二维表，供按表头识别；支持逗号与制表符分隔。
export function parseDelimitedMatrix(text: string): string[][] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
  const sample = lines.slice(0, 10).join('\n')
  const tabs = (sample.match(/\t/g) ?? []).length
  const commas = (sample.match(/,/g) ?? []).length
  const delimiter = tabs > 0 && tabs >= commas ? '\t' : ','
  return lines.map((line) =>
    delimiter === '\t' ? line.split('\t').map((cell) => cell.trim()) : splitCsvLine(line).map((cell) => cell.trim()),
  )
}

interface StatementColumns {
  date: number
  debit: number
  credit: number
  amount: number
  direction: number
  businessType: number
  summary: number
  purpose: number
  remark: number
  counterparty: number
  payer: number
  payee: number
  notes: number
  reference: number
}

// 交易类型/借贷标志里出现的方向词，优先于金额正负号。
function directionKind(direction: string): 'income' | 'expense' | null {
  if (!direction) return null
  if (/往账|往方|出账/.test(direction)) return 'expense'
  if (/来账|来方|入账/.test(direction)) return 'income'
  if (/收|贷|入|存/.test(direction)) return 'income'
  if (/支|付|借|取|出/.test(direction)) return 'expense'
  return null
}

function findColumn(headers: string[], keywords: string[]): number {
  for (const keyword of keywords) {
    const index = headers.findIndex((header) => header.includes(keyword))
    if (index >= 0) return index
  }
  return -1
}

function detectColumns(row: unknown[]): StatementColumns | null {
  const headers = row.map((cell) => statementCellText(cell).replace(/[\s\u3000]/g, ''))
  const date = findColumn(headers, ['记账日', '交易日期', '交易日', '记账日期', '交易时间', '入账日期', '入账日', '日期'])
  const debit = findColumn(headers, ['借方发生额', '借方金额', '支出金额', '付款金额', '借方', '支出'])
  const credit = findColumn(headers, ['贷方发生额', '贷方金额', '收入金额', '收款金额', '贷方', '收入'])
  const amount = findColumn(headers, ['交易金额', '发生额', '金额'])
  const direction = findColumn(headers, ['收付标志', '借贷标志', '交易类型', '收支类型', '方向'])
  if (date < 0) return null
  if (debit < 0 && credit < 0 && amount < 0 && direction < 0) return null
  return {
    date,
    debit,
    credit,
    amount,
    direction,
    businessType: findColumn(headers, ['业务类型']),
    summary: findColumn(headers, ['摘要', '交易备注', '交易说明', '说明']),
    purpose: findColumn(headers, ['用途']),
    remark: findColumn(headers, ['交易附言', '附言']),
    counterparty: findColumn(headers, ['对方户名', '对方名称', '对方账户名称', '收付款人', '对方']),
    payer: findColumn(headers, ['付款人名称', '付款方名称', '付款人户名']),
    payee: findColumn(headers, ['收款人名称', '收款方名称', '收款人户名']),
    notes: findColumn(headers, ['备注']),
    reference: findColumn(headers, ['交易流水号', '流水号', '客户业务编号', '业务编号', '凭证号码', '凭证号', '流水']),
  }
}

// 二维表 → 流水行。表头行在前 40 行内自动识别；列顺序不同、中英文表头均可。
export function parseStatementRows(matrix: unknown[][]): JournalImportParsedRow[] {
  let headerIndex = -1
  let columns: StatementColumns | null = null
  for (let index = 0; index < Math.min(matrix.length, 40); index += 1) {
    const detected = detectColumns(matrix[index])
    if (detected) {
      headerIndex = index
      columns = detected
      break
    }
  }
  if (!columns) return []

  const rows: JournalImportParsedRow[] = []
  for (const row of matrix.slice(headerIndex + 1)) {
    const entryDate = normalizeDateValue(row[columns.date])
    if (!entryDate) continue

    const debitValue = columns.debit >= 0 ? parseSignedAmount(statementCellText(row[columns.debit])) : null
    const creditValue = columns.credit >= 0 ? parseSignedAmount(statementCellText(row[columns.credit])) : null
    const debit = debitValue !== null ? Math.abs(debitValue) : null
    const credit = creditValue !== null ? Math.abs(creditValue) : null
    let kind: 'income' | 'expense' | null = null
    let amount: number | null = null
    if (debit !== null && credit === null) {
      kind = 'expense'
      amount = debit
    } else if (credit !== null && debit === null) {
      kind = 'income'
      amount = credit
    } else if (debit === null && credit === null && columns.amount >= 0) {
      const amountText = statementCellText(row[columns.amount])
      const signed = parseSignedAmount(amountText)
      const direction = columns.direction >= 0 ? statementCellText(row[columns.direction]) : ''
      const byDirection = directionKind(direction)
      if (signed !== null && byDirection) {
        kind = byDirection
        amount = Math.abs(signed)
      } else if (signed !== null && signed < 0) {
        kind = 'expense'
        amount = Math.abs(signed)
      } else if (signed !== null && (columns.direction < 0 || /^\+/.test(amountText.trim()))) {
        // 没有方向列时按正负号判断；部分银行收入金额带显式 + 号。
        kind = 'income'
        amount = Math.abs(signed)
      }
    }
    if (!kind || amount === null) continue

    const cell = (index: number) => (index >= 0 ? statementCellText(row[index]) : '')
    const summary =
      cell(columns.purpose) ||
      cell(columns.remark) ||
      cell(columns.summary) ||
      cell(columns.businessType) ||
      cell(columns.counterparty) ||
      cell(columns.notes) ||
      cell(columns.direction)
    if (!summary) continue

    // 中行把付款人、收款人拆成两列：支出取收款人，收入取付款人。
    const partyByDirection = kind === 'expense' ? cell(columns.payee) : cell(columns.payer)
    const counterparty =
      partyByDirection ||
      cell(columns.counterparty) ||
      (columns.notes >= 0 && columns.summary >= 0 ? cell(columns.notes) : '')
    const referenceRaw = cell(columns.reference)
    const referenceCandidate = referenceRaw
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean)
      .pop()
    // 中行的「凭证号码/业务编号/用途/摘要」是合并列，最后一段常常是用途而非编号。
    const referenceNo =
      referenceCandidate && /\d/.test(referenceCandidate) ? referenceCandidate : undefined

    rows.push({
      entry_date: entryDate,
      kind,
      amount_original: amount,
      summary,
      counterparty: counterparty || undefined,
      reference_no: referenceNo,
    })
  }
  return rows
}
