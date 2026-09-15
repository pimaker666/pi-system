import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import { requireApproved } from '@/lib/auth'
import {
  BUSINESS_DAILY_IMPORT_MAX_ROWS,
  mapBusinessDailyImportRows,
} from '@/lib/business-daily-import'
import { parseDelimitedText } from '@/lib/daily-orders'
import { fetchDailyOrderOptions } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'
import type { Customer } from '@/types'

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
  // 导入最终走 create_business_order_v4，写权限由该 RPC 与 RLS 判定；
  // 预览只做解析与基础数据匹配，因此这里按建单角色放行即可。
  const profile = await requireApproved()
  if (!['sales', 'supervisor', 'admin'].includes(profile.role)) {
    return NextResponse.json({ error: '当前角色不能批量导入每日订单' }, { status: 403 })
  }

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

  if (matrix.length - 1 > BUSINESS_DAILY_IMPORT_MAX_ROWS) {
    return NextResponse.json(
      { error: `一次最多导入 ${BUSINESS_DAILY_IMPORT_MAX_ROWS} 行` },
      { status: 400 },
    )
  }

  const supabase = await createClient()
  // 客户可见范围与新建订单页保持一致：管理员看全部，其余只看自己创建的客户。
  const customersQuery = supabase.from('customers').select('id, name')
  const [options, customersResult] = await Promise.all([
    fetchDailyOrderOptions(supabase),
    profile.role === 'admin'
      ? customersQuery.order('name')
      : customersQuery.eq('created_by', profile.id).order('name'),
  ])
  if (customersResult.error) {
    return NextResponse.json(
      { error: `客户基础数据读取失败：${customersResult.error.message}` },
      { status: 500 },
    )
  }

  return NextResponse.json({
    rows: mapBusinessDailyImportRows(matrix, {
      shops: options.shops.filter((shop) => shop.is_active),
      salespeople: options.salespeople,
      products: options.products,
      customers: (customersResult.data ?? []) as Pick<Customer, 'id' | 'name'>[],
    }),
  })
}
