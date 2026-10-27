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
