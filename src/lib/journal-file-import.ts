import {
  parseBocStatementText,
  parseCmbCsv,
  parseDelimitedMatrix,
  parseStatementRows,
  type JournalImportParsedRow,
} from '@/lib/journal-import'
import { extractPdfText } from '@/lib/pdf-import'

function decodeHtml(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gb18030').decode(bytes)
  } catch {
    return utf8
  }
}

// 部分银行导出的 .xls 实际是 HTML 表格，需要单独识别。
function looksLikeHtml(buffer: ArrayBuffer): boolean {
  const head = new TextDecoder('utf-8')
    .decode(new Uint8Array(buffer.slice(0, 4096)))
    .replace(/^\uFEFF/, '')
    .trimStart()
  return head.startsWith('<') && /<table/i.test(head)
}

function parseHtmlMatrix(html: string): string[][] {
  const document = new DOMParser().parseFromString(html, 'text/html')
  return [...document.querySelectorAll('table tr')].map((row) => {
    const values: string[] = []
    for (const cell of row.querySelectorAll('th, td')) {
      values.push(cell.textContent?.trim() ?? '')
      const span = Number(cell.getAttribute('colspan') ?? '1')
      for (let index = 1; index < span; index += 1) values.push('')
    }
    return values
  })
}

const MAX_FILE_BYTES = 20 * 1024 * 1024

function pipeMatrix(text: string): string[][] {
  return text.split(/\r?\n/).map((line) => line.split('|').map((cell) => cell.trim()))
}

async function parsePdf(file: File): Promise<JournalImportParsedRow[]> {
  let text: string
  try {
    text = await extractPdfText(file)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PDF 中没有')) throw error
    throw new Error('PDF 读取失败，请确认文件未加密、未损坏；扫描件请改用粘贴文本或 Excel/CSV')
  }
  const bocRows = parseBocStatementText(text)
  const rows = bocRows.length > 0 ? bocRows : parseStatementRows(pipeMatrix(text))
  if (rows.length === 0) {
    throw new Error('PDF 未能识别出流水，请改用 Excel/CSV；或打开对账单全选复制文字，用「粘贴对账单文本」导入')
  }
  return rows
}

async function parseExcel(buffer: ArrayBuffer): Promise<JournalImportParsedRow[]> {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as never)
  for (const worksheet of workbook.worksheets) {
    const matrix: unknown[][] = []
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      matrix.push(Array.isArray(row.values) ? row.values.slice(1) : [])
    })
    const rows = parseStatementRows(matrix)
    if (rows.length > 0) return rows
  }
  return []
}

export async function parseStatementFile(file: File): Promise<JournalImportParsedRow[]> {
  if (file.size === 0) throw new Error('文件为空，请重新导出对账单')
  if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 20MB，请拆分对账单或导出更小的文件')
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf')) {
    return parsePdf(file)
  }
  if (name.endsWith('.csv')) {
    const text = await file.text()
    const cmbRows = parseCmbCsv(text)
    return cmbRows.length > 0 ? cmbRows : parseStatementRows(parseDelimitedMatrix(text))
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const buffer = await file.arrayBuffer()
    if (looksLikeHtml(buffer)) {
      return parseStatementRows(parseHtmlMatrix(decodeHtml(buffer)))
    }
    const signature = new Uint8Array(buffer.slice(0, 8))
    if (signature[0] === 0xd0 && signature[1] === 0xcf) {
      throw new Error('暂不支持老版 .xls 二进制文件，请在网银重新导出 .xlsx 或 CSV')
    }
    try {
      return await parseExcel(buffer)
    } catch {
      throw new Error('Excel 文件解析失败，请确认文件未加密、未损坏，或在网银重新导出 .xlsx / CSV')
    }
  }
  throw new Error('仅支持 .csv / .xlsx / .xls / .pdf 文件')
}
