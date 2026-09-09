import { NextResponse } from 'next/server'
import { createElement } from 'react'
import { requireApproved } from '@/lib/auth'
import {
  BUSINESS_DAILY_EXPORT_MAX_IMAGE_BYTES,
  buildBusinessDailyExportRows,
  businessDailyExportLimitError,
} from '@/lib/business-daily-orders'
import { fetchBusinessDailyLedger } from '@/lib/business-daily-orders-server'
import { isRenderableExportImage } from '@/lib/export-image-guard'
import {
  formatDailyMoney,
  parseDailyOrderFilters,
  PAYMENT_LABELS,
  SHIPPING_LABELS,
} from '@/lib/daily-orders'
import { createClient } from '@/lib/supabase/server'
import { displayProfileName } from '@/lib/utils'
import type { DailyOrderPdfRow } from '@/components/finance/daily-orders-pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  // 与 XLSX 导出一致：可见范围交给 business_orders 的 RLS，不再限定财务角色。
  await requireApproved()
  const params = Object.fromEntries(new URL(request.url).searchParams.entries())
  const filters = parseDailyOrderFilters(params)
  const supabase = await createClient()
  const orders = await fetchBusinessDailyLedger(supabase, filters)
  const imageLimitError = businessDailyExportLimitError(orders)
  if (imageLimitError) return NextResponse.json({ error: imageLimitError }, { status: 413 })

  const exportRows = buildBusinessDailyExportRows(orders, {
    money: formatDailyMoney,
    shipping: (value) => (value ? SHIPPING_LABELS[value] : ''),
    payment: (value) => (value ? PAYMENT_LABELS[value] : ''),
    salesperson: (order) => displayProfileName(order.salesperson, order.salesperson_name_snapshot),
  })

  const rows: DailyOrderPdfRow[] = []
  let downloadedImageBytes = 0
  for (const exportRow of exportRows) {
    const imageSources: Array<string | null> = []
    for (const attachment of exportRow.attachments) {
      const { data, error } = await supabase.storage
        .from('finance-daily-order-screenshots')
        .download(attachment.object_path)
      if (error || !data) {
        imageSources.push(null)
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
      imageSources.push(
        (await isRenderableExportImage(imageBuffer))
          ? `data:${attachment.mime_type};base64,${imageBuffer.toString('base64')}`
          : null,
      )
    }
    rows.push({ ...exportRow, imageSources })
  }

  const [{ renderToBuffer }, { DailyOrdersPdf }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('@/components/finance/daily-orders-pdf'),
  ])
  let buffer: Buffer
  try {
    buffer = await renderToBuffer(createElement(DailyOrdersPdf, { orders: rows }) as never)
  } catch (error) {
    console.error('[daily-orders/export/pdf] renderToBuffer failed', error)
    return NextResponse.json({ error: 'PDF 生成失败，请稍后重试或缩小筛选范围' }, { status: 500 })
  }
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`财务每日订单台账_${new Date().toISOString().slice(0, 10)}.pdf`)}`,
      'Cache-Control': 'no-store',
    },
  })
}
