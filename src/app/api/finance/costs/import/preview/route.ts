import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import { requireFinanceAccess } from '@/lib/auth'
import { parseDelimitedText } from '@/lib/daily-orders'
import {
  COST_IMPORT_MAX_ROWS,
  matchCostImportRows,
} from '@/lib/business-order-cost-import'
import { BUSINESS_DAILY_EXPORT_LIMIT, fetchBusinessOrderProductCosts } from '@/lib/business-order-costs-server'
import { parseBusinessOrderCostFilters } from '@/lib/business-order-cost'
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
  // 预览只做解析与核对，不写库；写入仍走 updateBusinessOrderItemCostOverride（含财务权限与各订单行校验）。
  await requireFinanceAccess()

  const form = await request.formData()
  const file = form.get('file')
  const text = String(form.get('text') ?? '')
  let matrix: unknown[][] = []

  if (file instanceof File && file.size > 0) {
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: '导入文件不能超过 10MB' }, { status: 400 })
    }
    const name = file.name.toLowerCase()
    if (name.endsWith('.xlsx')) {
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(await file.arrayBuffer())
      const sheet =
        workbook.getWorksheet('业务订单产品成本') ?? workbook.worksheets[0]
      if (!sheet) return NextResponse.json({ error: 'Excel 中没有工作表' }, { status: 400 })
      sheet.eachRow((row) => {
        matrix.push(
          Array.from({ length: row.cellCount }, (_, index) => cellValue(row.getCell(index + 1).value)),
        )
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

  if (matrix.length - 1 > COST_IMPORT_MAX_ROWS) {
    return NextResponse.json(
      { error: `一次最多导入 ${COST_IMPORT_MAX_ROWS} 行` },
      { status: 400 },
    )
  }

  const supabase = await createClient()
  // 与全部未结算成本行比对：忽略当前分页与筛选，口径与「导出成本表」一致（最多 2000 张订单）。
  const { rows } = await fetchBusinessOrderProductCosts(
    supabase,
    parseBusinessOrderCostFilters({}),
    1,
    BUSINESS_DAILY_EXPORT_LIMIT,
  )

  try {
    const matched = matchCostImportRows(matrix, rows)
    return NextResponse.json({
      ...matched,
      summary: {
        autoFill: matched.autoFill.length,
        conflicts: matched.conflicts.length,
        unmatched: matched.unmatched.length,
        skipped: matched.skipped.length,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '解析失败'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
