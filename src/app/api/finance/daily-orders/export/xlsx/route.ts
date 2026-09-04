import ExcelJS from 'exceljs'
import { NextResponse } from 'next/server'
import { requireFinanceAccess } from '@/lib/auth'
import { DAILY_ORDER_COLUMNS, DAILY_ORDER_EXPORT_MAX_IMAGE_BYTES, dailyOrderExportLimitError, formatDailyMoney, parseDailyOrderFilters, PAYMENT_LABELS, SHIPPING_LABELS } from '@/lib/daily-orders'
import { fetchDailyOrders } from '@/lib/daily-orders-server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  await requireFinanceAccess()
  const params = Object.fromEntries(new URL(request.url).searchParams.entries())
  const filters = parseDailyOrderFilters(params)
  const supabase = await createClient()
  const orders = await fetchDailyOrders(supabase, filters, 500, true)
  const imageLimitError = dailyOrderExportLimitError(orders)
  if (imageLimitError) return NextResponse.json({ error: imageLimitError }, { status: 413 })
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
  for (let index = 0; index < orders.length; index += 1) {
    const order = orders[index]
    const row = sheet.addRow([
      index + 1, order.order_date, order.shop_name_snapshot, order.salesperson_name_snapshot,
      order.order_number, order.shipping_date, order.shipping_number ?? '', SHIPPING_LABELS[order.shipping_category],
      order.product_name_snapshot, Number(order.quantity),
      formatDailyMoney(order.sales_unit_price_amount, order.sales_unit_price_currency),
      formatDailyMoney(order.product_received_amount, order.product_received_currency),
      formatDailyMoney(order.logistics_fee_amount, order.logistics_fee_currency),
      formatDailyMoney(order.sales_total_amount, order.sales_total_currency),
      PAYMENT_LABELS[order.payment_category], order.remarks ?? '', '',
    ])
    row.alignment = { vertical: 'middle', wrapText: true }
    row.eachCell((cell) => { cell.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } } })
    const shots = (order.finance_daily_order_screenshots ?? []).filter((shot) => shot.status === 'active').slice(0, 10)
    const imageRows = Math.ceil(shots.length / 3)
    if (shots.length) row.height = Math.max(56, imageRows * 42)
    let unavailable = 0
    for (let shotIndex = 0; shotIndex < shots.length; shotIndex += 1) {
      const shot = shots[shotIndex]
      const { data, error } = await supabase.storage.from('finance-daily-order-screenshots').download(shot.object_path)
      if (error || !data) { unavailable += 1; continue }
      const imageBuffer = Buffer.from(await data.arrayBuffer())
      downloadedImageBytes += imageBuffer.byteLength
      if (downloadedImageBytes > DAILY_ORDER_EXPORT_MAX_IMAGE_BYTES) {
        return NextResponse.json({ error: '实际下载的截图总大小超过 50MB，请缩小筛选范围' }, { status: 413 })
      }
      const extension = shot.mime_type === 'image/png' ? 'png' : 'jpeg'
      const imageId = workbook.addImage({ base64: imageBuffer.toString('base64'), extension })
      const imageRow = Math.floor(shotIndex / 3)
      const imageColumnOffset = (shotIndex % 3) * 0.32
      sheet.addImage(imageId, {
        tl: { col: 16 + imageColumnOffset, row: row.number - 1 + imageRow / imageRows + 0.02 },
        ext: { width: 48, height: 48 }, editAs: 'oneCell',
      })
    }
    if (unavailable) sheet.getCell(row.number, 17).value = `${unavailable} 张图片不可用`
  }

  sheet.autoFilter = { from: 'A1', to: 'Q1' }
  const buffer = await workbook.xlsx.writeBuffer()
  return new NextResponse(new Uint8Array(buffer as ArrayBuffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`财务每日订单台账_${new Date().toISOString().slice(0, 10)}.xlsx`)}`,
      'Cache-Control': 'no-store',
    },
  })
}
