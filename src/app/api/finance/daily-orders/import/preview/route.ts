import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import { requireFinanceAccess } from '@/lib/auth'
import { mapDailyOrderImportRows, parseDelimitedText } from '@/lib/daily-orders'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function cellValue(value: ExcelJS.CellValue) {
  if (value instanceof Date) return value
  if (value && typeof value === 'object') {
    if ('result' in value) return value.result ?? ''
    if ('richText' in value) return value.richText.map((item) => item.text).join('')
    if ('text' in value) return value.text
  }
  return value ?? ''
}

export async function POST(request: Request) {
  await requireFinanceAccess()
  const form = await request.formData()
  const file = form.get('file')
  const text = String(form.get('text') ?? '')
  let matrix: unknown[][] = []

  if (file instanceof File && file.size > 0) {
    if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: '导入文件不能超过 10MB' }, { status: 400 })
    const name = file.name.toLowerCase()
    if (name.endsWith('.xlsx')) {
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(await file.arrayBuffer())
      const sheet = workbook.worksheets[0]
      if (!sheet) return NextResponse.json({ error: 'Excel 中没有工作表' }, { status: 400 })
      sheet.eachRow((row) => {
        matrix.push(Array.from({ length: row.cellCount }, (_, index) => cellValue(row.getCell(index + 1).value)))
      })
    } else if (name.endsWith('.csv') || file.type === 'text/csv') {
      matrix = parseDelimitedText(Buffer.from(await file.arrayBuffer()).toString('utf8').replace(/^\uFEFF/, ''))
    } else {
      return NextResponse.json({ error: '仅支持 .xlsx 或 .csv' }, { status: 400 })
    }
  } else if (text.trim()) {
    matrix = parseDelimitedText(text.replace(/^\uFEFF/, ''))
  } else {
    return NextResponse.json({ error: '未提供文件或文本' }, { status: 400 })
  }

  if (matrix.length - 1 > 500) return NextResponse.json({ error: '一次最多导入 500 行' }, { status: 400 })
  const supabase = await createClient()
  const refs = await fetchDailyOrderOptions(supabase)
  return NextResponse.json({
    rows: mapDailyOrderImportRows(matrix, {
      ...refs,
      shops: refs.shops.filter((shop) => shop.is_active),
    }),
  })
}
