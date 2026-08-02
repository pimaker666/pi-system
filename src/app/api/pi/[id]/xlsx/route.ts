import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import { createClient } from '@/lib/supabase/server'
import { buildPiFilename, contentDisposition } from '@/lib/pi-filename'
import { formatDate } from '@/lib/utils'
import { derivePalette, toArgb } from '@/lib/pi-theme'
import { toServerImageSrc } from '@/lib/supabase/image'
import type { CompanySettings, CompanySnapshot, ProformaInvoiceWithItems } from '@/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MUTED = 'FF6B7280'

/**
 * Export a full Proforma Invoice as an .xlsx workbook. Mirrors the PDF layout:
 * company header, Bill To, line items, totals, bank details, terms & notes.
 * RLS ensures only the owner (or an admin) can fetch a given PI.
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

  const [{ data: piData, error }, { data: companyData }] = await Promise.all([
    supabase.from('proforma_invoices').select('*, pi_items(*)').eq('id', id).single(),
    supabase.from('company_settings').select('*').eq('id', 1).maybeSingle(),
  ])

  if (error || !piData) {
    return new NextResponse('Not found', { status: 404 })
  }

  const pi = piData as ProformaInvoiceWithItems
  const company = (pi.company_snapshot ?? companyData ?? null) as
    | CompanySettings
    | CompanySnapshot
    | null
  const c = pi.customer_snapshot
  const items = [...pi.pi_items].sort((a, b) => a.sort_order - b.sort_order)

  // Brand-driven palette so the Excel export matches the PDF's tone.
  const pal = derivePalette(company?.accent_color)
  const ACCENT = toArgb(pal.accent)
  const ACCENT_DARK = toArgb(pal.accentDark)
  const ON_ACCENT = toArgb(pal.onAccent)
  const TINT = toArgb(pal.tint)
  const HAIRLINE = toArgb(pal.border)

  const wb = new ExcelJS.Workbook()
  wb.creator = company?.company_name ?? 'PI System'
  wb.created = new Date()
  const ws = wb.addWorksheet('Proforma Invoice', {
    properties: { defaultColWidth: 16 },
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true },
  })

  // Column layout. Specification is inserted after Image, then the optional
  // Weight column, then Qty — mirroring the PDF. Indices are 1-based; downstream
  // code references these vars so the layout stays correct regardless of which
  // optional columns are present.
  const showSpec = pi.show_specification !== false
  const showWeight = pi.show_weight === true
  const extra = (showSpec ? 1 : 0) + (showWeight ? 1 : 0)
  const COL_IDX = 1
  const COL_PRODUCT = 2
  const COL_SKU = 3
  const COL_IMAGE = 4
  const COL_SPEC = showSpec ? 5 : 0
  const COL_WEIGHT = showWeight ? (showSpec ? 6 : 5) : 0
  const base = 4 + extra
  const COL_QTY = base + 1
  const COL_UNIT = base + 2
  const COL_PRICE = base + 3
  const COL_AMOUNT = base + 4
  const COL_REMARK = base + 5
  const LAST_COL = COL_REMARK

  // Column widths, in the same order as the indices above.
  const baseWidths: { width: number }[] = [
    { width: 5 }, // #
    { width: showSpec ? 26 : 28 }, // Product
    { width: showSpec ? 14 : 16 }, // SKU
    { width: 13 }, // Image
  ]
  if (showSpec) baseWidths.push({ width: 22 }) // Specification
  if (showWeight) baseWidths.push({ width: 10 }) // Weight (g)
  baseWidths.push(
    { width: 8 }, // Qty
    { width: 8 }, // Unit
    { width: 14 }, // Unit Price
    { width: 14 }, // Amount
    { width: showSpec ? 22 : 24 }, // Remarks
  )
  ws.columns = baseWidths

  const money = '#,##0.00'

  const mergeRow = (row: number, from = 1, to = LAST_COL) =>
    ws.mergeCells(row, from, row, to)

  let r = 1

  // ---- Centered company letterhead (name banner + contact line) ----
  mergeRow(r)
  const cn = ws.getCell(r, 1)
  cn.value = company?.company_name ?? 'Your Company Name'
  cn.font = { size: 16, bold: true, color: { argb: ACCENT_DARK } }
  cn.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(r).height = 22
  r++

  const TEXT = toArgb(pal.text)

  // Upper contact line: phone / email / website.
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
  // Lower line: address.
  if (company?.address) {
    mergeRow(r)
    const ac = ws.getCell(r, 1)
    ac.value = company.address
    ac.font = { size: 9, bold: true, color: { argb: TEXT } }
    ac.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    r++
  }

  // Accent rule beneath the letterhead.
  mergeRow(r)
  ws.getCell(r, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT } }
  ws.getRow(r).height = 3
  r++

  // ---- Centered document title ----
  mergeRow(r)
  const titleCell = ws.getCell(r, 1)
  titleCell.value = 'PROFORMA INVOICE'
  titleCell.font = { size: 18, bold: true, color: { argb: ACCENT } }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(r).height = 26
  r++
  r++

  // ---- Two-column parties: Bill To (cols 1-4) / Invoice meta (cols 5-8) ----
  const billLines = [
    c.company,
    c.address,
    c.country,
    c.phone && `Tel: ${c.phone}`,
    c.email,
  ].filter(Boolean) as string[]

  const meta: [string, string][] = [
    ['PI No.', pi.pi_number],
    ['Date', formatDate(pi.created_at)],
    ['Currency', pi.currency],
  ]
  if (c.contact_person) meta.push(['Attn', c.contact_person])
  if (pi.status === 'void') meta.push(['Status', 'VOID'])

  const partiesTop = r

  // Bill To label + name
  ws.mergeCells(r, 1, r, 4)
  const billLabel = ws.getCell(r, 1)
  billLabel.value = 'BILL TO'
  billLabel.font = { bold: true, color: { argb: ACCENT } }
  r++
  ws.mergeCells(r, 1, r, 4)
  const billName = ws.getCell(r, 1)
  billName.value = c.name
  billName.font = { size: 11, bold: true }
  r++
  for (const line of billLines) {
    ws.mergeCells(r, 1, r, 4)
    ws.getCell(r, 1).value = line
    ws.getCell(r, 1).font = { size: 9 }
    r++
  }

  // Meta rows on the right column block (label col 5, value cols 6-8), aligned to the top.
  let mr = partiesTop
  for (const [k, v] of meta) {
    ws.getCell(mr, 5).value = k
    ws.getCell(mr, 5).font = { bold: true, color: { argb: MUTED } }
    ws.mergeCells(mr, 6, mr, LAST_COL)
    ws.getCell(mr, 6).value = v
    ws.getCell(mr, 6).font = {
      bold: true,
      color: v === 'VOID' ? { argb: 'FFC00000' } : undefined,
    }
    mr++
  }

  // Continue below whichever column ran longer.
  r = Math.max(r, mr)
  r++

  // ---- Items table header ----
  const headerRowIdx = r
  const headers: string[] = ['#', 'Product', 'SKU', 'Image']
  if (showSpec) headers.push('Specification')
  if (showWeight) headers.push('Weight (g)')
  headers.push('Qty', 'Unit', `Unit Price (${pi.currency})`, `Amount (${pi.currency})`, 'Remarks')
  headers.forEach((h, i) => {
    const colNo = i + 1
    const cell = ws.getCell(r, colNo)
    cell.value = h
    cell.font = { bold: true, color: { argb: ON_ACCENT } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT } }
    // Right-align numeric columns (Weight / Qty / Unit Price / Amount); center Image.
    cell.alignment = {
      horizontal:
        colNo === COL_IMAGE
          ? 'center'
          : colNo === COL_WEIGHT || colNo === COL_QTY || colNo === COL_PRICE || colNo === COL_AMOUNT
            ? 'right'
            : 'left',
      vertical: 'middle',
    }
  })
  ws.getRow(r).height = 20
  r++

  // ---- Items rows ----
  // Pre-fetch product + remark images so they can be embedded into the sheet.
  // exceljs needs raw base64 + extension; anything that fails falls back to text.
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
  const remarkImageIds = new Map<string, number>()
  await Promise.all(
    items.flatMap((item) => [
      item.image_url
        ? addRemoteImage(item.image_url).then((imgId) => {
            if (imgId !== undefined) productImageIds.set(item.id, imgId)
          })
        : Promise.resolve(),
      item.remark_image_url
        ? addRemoteImage(item.remark_image_url).then((imgId) => {
            if (imgId !== undefined) remarkImageIds.set(item.id, imgId)
          })
        : Promise.resolve(),
    ]),
  )

  items.forEach((item, idx) => {
    ws.getCell(r, COL_IDX).value = idx + 1
    ws.getCell(r, COL_PRODUCT).value = item.name
    ws.getCell(r, COL_SKU).value = item.sku
    // COL_IMAGE = Image (embedded below)
    if (showSpec) {
      ws.getCell(r, COL_SPEC).value = item.specification ?? ''
      ws.getCell(r, COL_SPEC).alignment = { vertical: 'middle', wrapText: true }
    }
    ws.getCell(r, COL_QTY).value = item.quantity
    ws.getCell(r, COL_UNIT).value = item.unit
    ws.getCell(r, COL_PRICE).value = item.unit_price
    ws.getCell(r, COL_PRICE).numFmt = money
    ws.getCell(r, COL_AMOUNT).value = item.line_total
    ws.getCell(r, COL_AMOUNT).numFmt = money
    ws.getCell(r, COL_REMARK).value = item.description ?? ''
    const zebra = idx % 2 === 1
    for (let col = 1; col <= LAST_COL; col++) {
      const cell = ws.getCell(r, col)
      cell.border = { bottom: { style: 'thin', color: { argb: HAIRLINE } } }
      if (zebra) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TINT } }
      if (col === COL_QTY || col === COL_PRICE || col === COL_AMOUNT)
        cell.alignment = { horizontal: 'right', vertical: 'middle' }
    }

    const productImgId = productImageIds.get(item.id)
    const remarkImgId = remarkImageIds.get(item.id)

    // Any embedded image needs a taller row so the picture isn't clipped.
    if (productImgId !== undefined || remarkImgId !== undefined) {
      ws.getRow(r).height = 60
    }
    // Product thumbnail floats over the Image column (0-based col index).
    if (productImgId !== undefined) {
      ws.addImage(productImgId, {
        tl: { col: COL_IMAGE - 1 + 0.15, row: r - 1 + 0.08 },
        ext: { width: 64, height: 64 },
        editAs: 'oneCell',
      })
    }
    // Remark image floats over the Remarks column (0-based col index).
    if (remarkImgId !== undefined) {
      ws.getCell(r, COL_REMARK).alignment = { vertical: 'bottom', wrapText: true }
      ws.addImage(remarkImgId, {
        tl: { col: COL_REMARK - 1 + 0.1, row: r - 1 + 0.08 },
        ext: { width: 64, height: 64 },
        editAs: 'oneCell',
      })
    }
    r++
  })
  r++

  // ---- Totals (right-aligned in Unit Price / Amount columns) ----
  const totalRows: [string, number][] = [['Subtotal', pi.subtotal]]
  if (pi.discount > 0) totalRows.push(['Discount', -pi.discount])
  if (pi.tax_rate > 0) totalRows.push([`Tax (${pi.tax_rate}%)`, pi.tax_amount])
  for (const [label, amount] of totalRows) {
    ws.getCell(r, COL_PRICE).value = label
    ws.getCell(r, COL_PRICE).alignment = { horizontal: 'right' }
    ws.getCell(r, COL_PRICE).font = { color: { argb: MUTED } }
    ws.getCell(r, COL_AMOUNT).value = amount
    ws.getCell(r, COL_AMOUNT).numFmt = money
    ws.getCell(r, COL_AMOUNT).alignment = { horizontal: 'right' }
    r++
  }
  // Shipping row: transport method on the left, "Shipping Freight" label + amount on the right.
  if (pi.shipping_fee > 0 || pi.shipping_method) {
    if (pi.shipping_method) {
      ws.mergeCells(r, COL_IDX, r, COL_UNIT)
      ws.getCell(r, COL_IDX).value = pi.shipping_method
      ws.getCell(r, COL_IDX).alignment = { horizontal: 'right' }
      ws.getCell(r, COL_IDX).font = { italic: true, color: { argb: MUTED } }
    }
    ws.getCell(r, COL_PRICE).value = 'Shipping Freight'
    ws.getCell(r, COL_PRICE).alignment = { horizontal: 'right' }
    ws.getCell(r, COL_PRICE).font = { color: { argb: MUTED } }
    ws.getCell(r, COL_AMOUNT).value = pi.shipping_fee
    ws.getCell(r, COL_AMOUNT).numFmt = money
    ws.getCell(r, COL_AMOUNT).alignment = { horizontal: 'right' }
    r++
  }
  ws.getCell(r, COL_PRICE).value = `Grand Total (${pi.currency})`
  ws.getCell(r, COL_PRICE).alignment = { horizontal: 'right' }
  ws.getCell(r, COL_PRICE).font = { bold: true, color: { argb: ON_ACCENT } }
  ws.getCell(r, COL_PRICE).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT_DARK } }
  ws.getCell(r, COL_AMOUNT).value = pi.total
  ws.getCell(r, COL_AMOUNT).numFmt = money
  ws.getCell(r, COL_AMOUNT).alignment = { horizontal: 'right' }
  ws.getCell(r, COL_AMOUNT).font = { bold: true, color: { argb: ON_ACCENT } }
  ws.getCell(r, COL_AMOUNT).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT_DARK } }
  r += 2

  // ---- Bank remittance ----
  const bank: [string, string | null | undefined][] = [
    ['Beneficiary Bank', company?.bank_name],
    ['Account No.', company?.bank_account],
    ['SWIFT / BIC', company?.bank_swift],
    ['Beneficiary Name', company?.company_name],
    ['Bank Address', company?.bank_address],
  ]
  const hasBank = bank.some(([, v]) => v)
  if (hasBank) {
    mergeRow(r)
    ws.getCell(r, 1).value = 'BANK REMITTANCE DETAILS'
    ws.getCell(r, 1).font = { bold: true, color: { argb: ACCENT } }
    r++
    for (const [k, v] of bank) {
      if (!v) continue
      ws.getCell(r, 1).value = k
      ws.getCell(r, 1).font = { color: { argb: MUTED } }
      ws.mergeCells(r, 2, r, LAST_COL)
      ws.getCell(r, 2).value = v
      r++
    }
    r++
  }

  // ---- Terms & Notes ----
  const blocks: [string, string | null][] = [
    ['Terms & Conditions', pi.terms],
    ['Notes', pi.notes],
  ]
  for (const [label, body] of blocks) {
    if (!body) continue
    mergeRow(r)
    ws.getCell(r, 1).value = label
    ws.getCell(r, 1).font = { bold: true, color: { argb: ACCENT } }
    r++
    mergeRow(r)
    ws.getCell(r, 1).value = body
    ws.getCell(r, 1).alignment = { wrapText: true, vertical: 'top' }
    ws.getRow(r).height = 40
    r++
  }

  // Freeze the item header row for scrollability.
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }]

  const arrayBuffer = await wb.xlsx.writeBuffer()

  return new NextResponse(new Uint8Array(arrayBuffer as ArrayBuffer), {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': contentDisposition(buildPiFilename(pi, 'xlsx')),
      'Cache-Control': 'no-store',
    },
  })
}
