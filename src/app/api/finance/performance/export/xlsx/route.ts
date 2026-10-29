import ExcelJS from 'exceljs'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApproved } from '@/lib/auth'
import { chinaToday } from '@/lib/daily-order-costs-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_COLUMNS = 20
const MAX_ROWS = 20000

const cellSchema = z.union([z.string().max(200), z.number().finite(), z.null()])
const exportSchema = z
  .object({
    fileName: z.string().trim().min(1).max(120),
    sheetName: z.string().trim().min(1).max(31),
    columns: z.array(z.string().trim().min(1).max(80)).min(1).max(MAX_COLUMNS),
    rows: z.array(cellSchema.array().max(MAX_COLUMNS)).max(MAX_ROWS),
    totalRow: cellSchema.array().max(MAX_COLUMNS).optional(),
  })
  .strict()

// 业绩页把已按当前勾选状态渲染好的表格原样提交，这里只负责排版成 xlsx：
// 数据来自页面已通过权限过滤的结果，接口不额外读取业务数据。
export async function POST(request: Request) {
  await requireApproved()
  const body: unknown = await request.json().catch(() => null)
  const parsed = exportSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? '导出条件无效' }, { status: 400 })
  }
  const { sheetName, columns, rows, totalRow } = parsed.data
  if (rows.some((row) => row.length !== columns.length) || (totalRow && totalRow.length !== columns.length)) {
    return NextResponse.json({ error: '导出列与数据不一致' }, { status: 400 })
  }
  if (rows.length === 0 && !totalRow) {
    return NextResponse.json({ error: '当前筛选范围没有可导出的数据' }, { status: 400 })
  }

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'PI System'
  const sheet = workbook.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] })
  const widths = columns.map((column, index) => {
    const contentWidth = rows.reduce((max, row) => {
      const value = row[index]
      return typeof value === 'number' ? Math.max(max, String(value).length) : max
    }, 0)
    return { width: Math.min(40, Math.max(12, column.length * 2 + 6, contentWidth + 4)) }
  })
  sheet.columns = widths

  const header = sheet.addRow(columns)
  header.height = 24
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })

  for (const values of rows) {
    const row = sheet.addRow(values)
    row.alignment = { vertical: 'middle' }
    row.eachCell((cell) => {
      if (typeof cell.value === 'number') cell.numFmt = '#,##0'
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
    })
  }

  if (totalRow) {
    const row = sheet.addRow(totalRow)
    row.font = { bold: true }
    row.eachCell((cell) => {
      if (typeof cell.value === 'number') cell.numFmt = '#,##0'
      cell.border = { top: { style: 'thin', color: { argb: 'FF94A3B8' } } }
    })
  }

  if (rows.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: rows.length + 1, column: columns.length },
    }
  }

  const buffer = await workbook.xlsx.writeBuffer()
  const bytes = new Uint8Array(buffer as ArrayBuffer)
  const fileName = parsed.data.fileName.toLowerCase().endsWith('.xlsx')
    ? parsed.data.fileName
    : `${parsed.data.fileName}.xlsx`
  return new NextResponse(bytes, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="performance-${chinaToday()}.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
