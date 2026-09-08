import ExcelJS from 'exceljs'
import { NextResponse } from 'next/server'
import { requireApproved } from '@/lib/auth'
import {
  BUSINESS_DAILY_EXPORT_MAX_IMAGE_BYTES,
  buildBusinessDailyExportRows,
  businessDailyExportLimitError,
} from '@/lib/business-daily-orders'
import { fetchBusinessDailyLedger } from '@/lib/business-daily-orders-server'
import {
  DAILY_ORDER_COLUMNS,
  formatDailyMoney,
  parseDailyOrderFilters,
  PAYMENT_LABELS,
  SHIPPING_LABELS,
} from '@/lib/daily-orders'
import { createClient } from '@/lib/supabase/server'
import { displayProfileName } from '@/lib/utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 截图列（第 17 列）的 0 基列号，用于 addImage 定位。 */
const SCREENSHOT_COLUMN_INDEX = DAILY_ORDER_COLUMNS.length - 1

export async function GET(request: Request) {
  // 每日订单台账对所有已审核角色开放（业务员也要能导出自己可见的订单），
  // 可见范围由 business_orders 的 RLS 决定，而不是页面级角色门禁。
  await requireApproved()
  const params = Object.fromEntries(new URL(request.url).searchParams.entries())
  const filters = parseDailyOrderFilters(params)
  const supabase = await createClient()
  const orders = await fetchBusinessDailyLedger(supabase, filters)
  const imageLimitError = businessDailyExportLimitError(orders)
  if (imageLimitError) return NextResponse.json({ error: imageLimitError }, { status: 413 })

  const rows = buildBusinessDailyExportRows(orders, {
    money: formatDailyMoney,
    shipping: (value) => (value ? SHIPPING_LABELS[value] : ''),
    payment: (value) => (value ? PAYMENT_LABELS[value] : ''),
    salesperson: (order) => displayProfileName(order.salesperson, order.salesperson_name_snapshot),
  })

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'PI System'
  const sheet = workbook.addWorksheet('每日订单台账', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [6, 13, 16, 16, 18, 13, 20, 12, 28, 12, 18, 20, 18, 20, 12, 30, 28].map((width) => ({ width }))
  const header = sheet.addRow([...DAILY_ORDER_COLUMNS])
  header.height = 24
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })

  let downloadedImageBytes = 0
  for (const exportRow of rows) {
    const row = sheet.addRow([
      exportRow.sequence,
      exportRow.orderDate,
      exportRow.shop,
      exportRow.salesperson,
      exportRow.orderNumber,
      exportRow.shippingDate,
      exportRow.shippingNumber,
      exportRow.shippingCategory,
      exportRow.productSku ? `${exportRow.productName}\n${exportRow.productSku}` : exportRow.productName,
      exportRow.quantity ? Number(exportRow.quantity) : '',
      exportRow.unitPrice,
      exportRow.productReceived,
      exportRow.logisticsFee,
      exportRow.salesTotal,
      exportRow.paymentCategory,
      exportRow.remarks,
      '',
    ])
    row.alignment = { vertical: 'middle', wrapText: true }
    row.eachCell((cell) => {
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
    })

    const attachments = exportRow.attachments
    const imageRows = Math.ceil(attachments.length / 3)
    if (attachments.length) row.height = Math.max(56, imageRows * 42)
    let unavailable = 0
    for (let shotIndex = 0; shotIndex < attachments.length; shotIndex += 1) {
      const attachment = attachments[shotIndex]
      const { data, error } = await supabase.storage
        .from('finance-daily-order-screenshots')
        .download(attachment.object_path)
      if (error || !data) {
        unavailable += 1
        continue
      }
      const imageBuffer = Buffer.from(await data.arrayBuffer())
      downloadedImageBytes += imageBuffer.byteLength
      if (downloadedImageBytes > BUSINESS_DAILY_EXPORT_MAX_IMAGE_BYTES) {
        return NextResponse.json(
          { error: '实际下载的截图总大小超过 50MB，请缩小筛选范围' },
          { status: 413 },
        )
      }
      const extension = attachment.mime_type === 'image/png' ? 'png' : 'jpeg'
      const imageId = workbook.addImage({ base64: imageBuffer.toString('base64'), extension })
      const imageRow = Math.floor(shotIndex / 3)
      const imageColumnOffset = (shotIndex % 3) * 0.32
      sheet.addImage(imageId, {
        tl: {
          col: SCREENSHOT_COLUMN_INDEX + imageColumnOffset,
          row: row.number - 1 + imageRow / imageRows + 0.02,
        },
        ext: { width: 48, height: 48 },
        editAs: 'oneCell',
      })
    }
    if (unavailable) {
      sheet.getCell(row.number, DAILY_ORDER_COLUMNS.length).value = `${unavailable} 张图片不可用`
    }
  }

  sheet.autoFilter = { from: 'A1', to: 'Q1' }
  const buffer = await workbook.xlsx.writeBuffer()
  const body = new Uint8Array(buffer as ArrayBuffer)
  const date = new Date().toISOString().slice(0, 10)
  const fileName = `财务每日订单台账_${date}.xlsx`
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="finance-daily-orders-${date}.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Content-Length': String(body.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
