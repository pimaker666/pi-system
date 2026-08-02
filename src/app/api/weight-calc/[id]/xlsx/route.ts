import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import { createClient } from '@/lib/supabase/server'
import { buildWeightCalcFilename, contentDisposition } from '@/lib/pi-filename'
import { formatDate } from '@/lib/utils'
import { derivePalette, toArgb } from '@/lib/pi-theme'
import { toServerImageSrc } from '@/lib/supabase/image'
import type {
  CompanySettings,
  WeightCalculationWithItems,
  WeightCalcItem,
} from '@/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MUTED = 'FF6B7280'

/**
 * Export a saved weight calculation as an .xlsx workbook: company letterhead,
 * calc meta (No./Date/Source PI), a line-item table (Product / SKU / Image /
 * Weight(g) / Qty / Total Weight(KG)) and a footer totals row. RLS ensures only
 * the owner (or an admin) can fetch a given calculation.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const [{ data: calcData, error }, { data: companyData }] = await Promise.all([
    supabase
      .from('weight_calculations')
      .select('*, weight_calc_items(*), source_pi:proforma_invoices(pi_number)')
      .eq('id', id)
      .single(),
    supabase.from('company_settings').select('*').eq('id', 1).maybeSingle(),
  ])

  if (error || !calcData) {
    return new NextResponse('Not found', { status: 404 })
  }

  const calc = calcData as WeightCalculationWithItems & {
    source_pi: { pi_number: string } | null
  }
  const company = (companyData ?? null) as CompanySettings | null
  const items = [...(calc.weight_calc_items ?? [])].sort(
    (a, b) => a.sort_order - b.sort_order,
  )

  const pal = derivePalette(company?.accent_color)
  const ACCENT = toArgb(pal.accent)
  const ACCENT_DARK = toArgb(pal.accentDark)
  const ON_ACCENT = toArgb(pal.onAccent)
  const TINT = toArgb(pal.tint)
  const HAIRLINE = toArgb(pal.border)
  const TEXT = toArgb(pal.text)

  const wb = new ExcelJS.Workbook()
  wb.creator = company?.company_name ?? 'PI System'
  wb.created = new Date()
  const ws = wb.addWorksheet('Weight Calculation', {
    properties: { defaultColWidth: 16 },
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true },
  })

  // Column layout (1-based): #, Product, SKU, Image, Weight(g), Qty, Total(KG).
  const COL_IDX = 1
  const COL_PRODUCT = 2
  const COL_SKU = 3
  const COL_IMAGE = 4
  const COL_WEIGHT = 5
  const COL_QTY = 6
  const COL_TOTAL = 7
  const LAST_COL = COL_TOTAL

  ws.columns = [
    { width: 5 }, // #
    { width: 30 }, // Product
    { width: 16 }, // SKU
    { width: 13 }, // Image
    { width: 12 }, // Weight (g)
    { width: 10 }, // Qty
    { width: 16 }, // Total Weight (KG)
  ]

  const num2 = '#,##0.00'
  const num3 = '#,##0.000'

  const mergeRow = (row: number, from = 1, to = LAST_COL) =>
    ws.mergeCells(row, from, row, to)

  let r = 1

  // ---- Company letterhead ----
  mergeRow(r)
  const cn = ws.getCell(r, 1)
  cn.value = company?.company_name ?? 'Your Company Name'
  cn.font = { size: 16, bold: true, color: { argb: ACCENT_DARK } }
  cn.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(r).height = 22
  r++

  const contactTop = [
    company?.phone && `Tel/WhatsApp: ${company.phone}`,
    company?.email,
    company?.website,
  ].filter(Boolean) as string[]
  if (contactTop.length) {
    mergeRow(r)
    const cc = ws.getCell(r, 1)
    cc.value = contactTop.join('    ·    ')
    cc.font = { size: 9, bold: true, color: { argb: TEXT } }
    cc.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    r++
  }
  if (company?.address) {
    mergeRow(r)
    const ac = ws.getCell(r, 1)
    ac.value = company.address
    ac.font = { size: 9, bold: true, color: { argb: TEXT } }
    ac.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    r++
  }

  mergeRow(r)
  ws.getCell(r, 1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: ACCENT },
  }
  ws.getRow(r).height = 3
  r++

  // ---- Title ----
  mergeRow(r)
  const titleCell = ws.getCell(r, 1)
  titleCell.value = 'WEIGHT CALCULATION'
  titleCell.font = { size: 18, bold: true, color: { argb: ACCENT } }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(r).height = 26
  r++
  if (calc.title) {
    mergeRow(r)
    const st = ws.getCell(r, 1)
    st.value = calc.title
    st.font = { size: 11, bold: true, color: { argb: TEXT } }
    st.alignment = { horizontal: 'center', vertical: 'middle' }
    r++
  }
  r++

  // ---- Meta ----
  const meta: [string, string][] = [
    ['Calc No.', calc.calc_number],
    ['Date', formatDate(calc.created_at)],
  ]
  if (calc.source_pi?.pi_number) meta.push(['Source PI', calc.source_pi.pi_number])
  for (const [k, v] of meta) {
    ws.getCell(r, 1).value = k
    ws.getCell(r, 1).font = { bold: true, color: { argb: MUTED } }
    ws.mergeCells(r, 2, r, LAST_COL)
    ws.getCell(r, 2).value = v
    ws.getCell(r, 2).font = { bold: true }
    r++
  }
  r++

  // ---- Items table header ----
  const headerRowIdx = r
  const headers = ['#', 'Product', 'SKU', 'Image', 'Weight (g)', 'Qty', 'Total (KG)']
  headers.forEach((h, i) => {
    const colNo = i + 1
    const cell = ws.getCell(r, colNo)
    cell.value = h
    cell.font = { bold: true, color: { argb: ON_ACCENT } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT } }
    cell.alignment = {
      horizontal:
        colNo === COL_IMAGE
          ? 'center'
          : colNo === COL_WEIGHT || colNo === COL_QTY || colNo === COL_TOTAL
            ? 'right'
            : 'left',
      vertical: 'middle',
    }
  })
  ws.getRow(r).height = 20
  r++

  // Pre-fetch product images for embedding.
  const addRemoteImage = async (url: string): Promise<number | undefined> => {
    try {
      const res = await fetch(toServerImageSrc(url))
      if (!res.ok) return undefined
      const base64 = Buffer.from(await res.arrayBuffer()).toString('base64')
      const ext = url.split('?')[0].match(/\.(png|jpe?g|gif)$/i)?.[1]?.toLowerCase()
      const extension: 'png' | 'jpeg' | 'gif' =
        ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'gif' ? 'gif' : 'png'
      return wb.addImage({ base64, extension })
    } catch {
      return undefined
    }
  }

  const productImageIds = new Map<string, number>()
  await Promise.all(
    items.map((item: WeightCalcItem) =>
      item.image_url
        ? addRemoteImage(item.image_url).then((imgId) => {
            if (imgId !== undefined) productImageIds.set(item.id, imgId)
          })
        : Promise.resolve(),
    ),
  )

  // ---- Items rows ----
  items.forEach((item: WeightCalcItem, idx: number) => {
    ws.getCell(r, COL_IDX).value = idx + 1
    ws.getCell(r, COL_PRODUCT).value = item.name
    ws.getCell(r, COL_SKU).value = item.sku ?? ''
    ws.getCell(r, COL_WEIGHT).value = Number(item.weight_g)
    ws.getCell(r, COL_WEIGHT).numFmt = num3
    ws.getCell(r, COL_QTY).value = Number(item.quantity)
    ws.getCell(r, COL_QTY).numFmt = num2
    ws.getCell(r, COL_TOTAL).value = Number(item.line_weight_g) / 1000
    ws.getCell(r, COL_TOTAL).numFmt = num3

    const zebra = idx % 2 === 1
    for (let col = 1; col <= LAST_COL; col++) {
      const cell = ws.getCell(r, col)
      cell.border = { bottom: { style: 'thin', color: { argb: HAIRLINE } } }
      if (zebra) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TINT } }
      if (col === COL_WEIGHT || col === COL_QTY || col === COL_TOTAL)
        cell.alignment = { horizontal: 'right', vertical: 'middle' }
    }

    const productImgId = productImageIds.get(item.id)
    if (productImgId !== undefined) {
      ws.getRow(r).height = 60
      ws.addImage(productImgId, {
        tl: { col: COL_IMAGE - 1 + 0.15, row: r - 1 + 0.08 },
        ext: { width: 64, height: 64 },
        editAs: 'oneCell',
      })
    }
    r++
  })

  // ---- Totals footer ----
  ws.getCell(r, COL_PRODUCT).value = 'TOTAL'
  ws.getCell(r, COL_PRODUCT).font = { bold: true, color: { argb: ON_ACCENT } }
  ws.getCell(r, COL_QTY).value = Number(calc.total_quantity)
  ws.getCell(r, COL_QTY).numFmt = num2
  ws.getCell(r, COL_TOTAL).value = Number(calc.total_weight_g) / 1000
  ws.getCell(r, COL_TOTAL).numFmt = num3
  for (let col = 1; col <= LAST_COL; col++) {
    const cell = ws.getCell(r, col)
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT_DARK } }
    cell.font = { bold: true, color: { argb: ON_ACCENT } }
    if (col === COL_QTY || col === COL_TOTAL)
      cell.alignment = { horizontal: 'right', vertical: 'middle' }
  }
  ws.getRow(r).height = 20

  // Freeze the header row for scrollability.
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }]

  const arrayBuffer = await wb.xlsx.writeBuffer()

  return new NextResponse(new Uint8Array(arrayBuffer as ArrayBuffer), {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': contentDisposition(
        buildWeightCalcFilename(calc, 'xlsx'),
      ),
      'Cache-Control': 'no-store',
    },
  })
}
