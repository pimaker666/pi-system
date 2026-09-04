import { NextResponse } from 'next/server'
import { createElement } from 'react'
import { requireFinanceAccess } from '@/lib/auth'
import { DAILY_ORDER_EXPORT_MAX_IMAGE_BYTES, dailyOrderExportLimitError, parseDailyOrderFilters } from '@/lib/daily-orders'
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
  const rows = []
  let downloadedImageBytes = 0
  for (const order of orders) {
    const imageSources: Array<string | null> = []
    for (const screenshot of (order.finance_daily_order_screenshots ?? []).filter((item) => item.status === 'active').slice(0, 10)) {
      const { data, error } = await supabase.storage.from('finance-daily-order-screenshots').download(screenshot.object_path)
      if (error || !data) {
        imageSources.push(null)
        continue
      }
      const imageBuffer = Buffer.from(await data.arrayBuffer())
      downloadedImageBytes += imageBuffer.byteLength
      if (downloadedImageBytes > DAILY_ORDER_EXPORT_MAX_IMAGE_BYTES) {
        return NextResponse.json({ error: '实际下载的截图总大小超过 50MB，请缩小筛选范围' }, { status: 413 })
      }
      imageSources.push(`data:${screenshot.mime_type};base64,${imageBuffer.toString('base64')}`)
    }
    rows.push({ ...order, imageSources })
  }
  const [{ renderToBuffer }, { DailyOrdersPdf }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('@/components/finance/daily-orders-pdf'),
  ])
  const buffer = await renderToBuffer(createElement(DailyOrdersPdf, { orders: rows }) as never)
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`财务每日订单台账_${new Date().toISOString().slice(0, 10)}.pdf`)}`,
      'Cache-Control': 'no-store',
    },
  })
}
