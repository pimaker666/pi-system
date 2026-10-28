import ExcelJS from 'exceljs'
import { NextResponse } from 'next/server'
import { isRenderableExportImage } from '@/lib/export-image-guard'
import { createClient } from '@/lib/supabase/server'
import { displayProfileName, formatDate } from '@/lib/utils'
import type { FinanceReimbursementRequest } from '@/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RECEIPT_BUCKET = 'finance-reimbursement-receipts'
// 凭证图按行嵌入，防呆上限：单张 20MB 上传限制内，整单凭证总量不超过 100MB
const MAX_RECEIPT_BYTES = 100 * 1024 * 1024

const STATUS_TEXT: Record<FinanceReimbursementRequest['status'], string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
  completed: '已完成',
}

// 凭证图所在 0 基列号（F 列），与下方列宽数组保持一致
const RECEIPT_COLUMN_INDEX = 5
const RECEIPT_DISPLAY = { width: 190, height: 96 }
// Excel 行高上限 409.5pt，每行纵向最多叠 5 张（每张 96px ≈ 75pt）
const MAX_RECEIPTS_PER_ROW = 5

export async function GET(request: Request) {
  const requestId = new URL(request.url).searchParams.get('request_id')
  if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
    return NextResponse.json({ error: '报销单 ID 无效' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: reimbursement, error } = await supabase
    .from('finance_reimbursement_requests')
    .select(
      '*, applicant:profiles!finance_reimbursement_requests_applicant_id_fkey(id, chinese_name, full_name, email), reviewer:profiles!finance_reimbursement_requests_reviewed_by_fkey(id, chinese_name, full_name, email), completer:profiles!finance_reimbursement_requests_completed_by_fkey(id, chinese_name, full_name, email), items:finance_reimbursement_items(*)',
    )
    .eq('id', requestId)
    .maybeSingle()
  // 可见性由 RLS 决定：本人 / 财务 / 管理员
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!reimbursement) return NextResponse.json({ error: '报销单不存在或无权限' }, { status: 404 })

  const data = reimbursement as unknown as FinanceReimbursementRequest & {
    completer?: Pick<
      NonNullable<FinanceReimbursementRequest['applicant']>,
      'id' | 'chinese_name' | 'full_name' | 'email'
    > | null
  }
  const items = [...(data.items ?? [])].sort((a, b) => a.sort_order - b.sort_order)

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'PI System'
  const sheet = workbook.addWorksheet('费用报销单')
  sheet.columns = [46, 12, 10, 14, 2, 30].map((width) => ({ width }))

  // 标题
  sheet.mergeCells('A1:F1')
  const titleCell = sheet.getCell('A1')
  titleCell.value = '费  用  报  销  单'
  titleCell.font = { size: 18, bold: true }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  sheet.getRow(1).height = 36

  // 报销日期（2026 年 8 月 31 日 模板口径）
  const [year, month, day] = data.expense_date.split('-').map(Number)
  sheet.mergeCells('A2:F2')
  sheet.getCell('A2').value = `报销日期：  ${year} 年 ${month} 月 ${day} 日`
  sheet.getCell('A2').alignment = { horizontal: 'left', vertical: 'middle' }
  sheet.getRow(2).height = 22

  // 报销人 / 项目名称
  sheet.getCell('A3').value = '报销人'
  sheet.getCell('A3').font = { bold: true }
  sheet.getCell('B3').value = displayProfileName(data.applicant)
  sheet.getCell('D3').value = '项目名称'
  sheet.getCell('D3').font = { bold: true }
  sheet.getCell('E3').value = data.project_name ?? ''
  sheet.getRow(3).height = 22

  // 表头
  const header = sheet.addRow(['摘要', '单价', '数量', '总金额', '', '凭证图片'])
  header.height = 22
  header.eachCell((cell, col) => {
    if (col === 5) return
    cell.font = { bold: true }
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF9CA3AF' } } }
  })

  let receiptBytes = 0
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const receiptPaths = item.receipt_paths ?? []
    const embedCount = Math.min(receiptPaths.length, MAX_RECEIPTS_PER_ROW)
    const row = sheet.addRow([
      item.summary,
      Number(item.unit_price),
      Number(item.quantity),
      Number(item.amount),
      '',
      receiptPaths.length > 0 ? '凭证加载中' : '',
    ])
    row.height = Math.max(embedCount, 1) * RECEIPT_DISPLAY.height * 0.78 // pt ≈ px * 0.75，行高适配叠放图片
    row.alignment = { vertical: 'middle', wrapText: true }
    row.getCell(1).alignment = { vertical: 'middle', wrapText: true, horizontal: 'left' }
    for (const col of [2, 3, 4]) {
      row.getCell(col).numFmt = '#,##0.00'
      row.getCell(col).alignment = { horizontal: 'right', vertical: 'middle' }
    }
    row.eachCell((cell) => {
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
    })

    if (receiptPaths.length === 0) continue
    if (receiptPaths.length > MAX_RECEIPTS_PER_ROW) {
      row.getCell(RECEIPT_COLUMN_INDEX + 1).value = `共 ${receiptPaths.length} 张，嵌入前 ${MAX_RECEIPTS_PER_ROW} 张`
    }
    const slot = 1 / Math.max(embedCount, 1)
    for (let imageIndex = 0; imageIndex < embedCount; imageIndex += 1) {
      const receiptPath = receiptPaths[imageIndex]
      const { data: blob, error: downloadError } = await supabase.storage
        .from(RECEIPT_BUCKET)
        .download(receiptPath)
      if (downloadError || !blob) {
        row.getCell(RECEIPT_COLUMN_INDEX + 1).value = '凭证不可用'
        continue
      }
      const imageBuffer = Buffer.from(await blob.arrayBuffer())
      receiptBytes += imageBuffer.byteLength
      if (receiptBytes > MAX_RECEIPT_BYTES) {
        row.getCell(RECEIPT_COLUMN_INDEX + 1).value = '凭证过大未嵌入'
        continue
      }
      if (!(await isRenderableExportImage(imageBuffer))) {
        row.getCell(RECEIPT_COLUMN_INDEX + 1).value = '凭证不可用'
        continue
      }
      const extension = receiptPath.toLowerCase().endsWith('.png') ? 'png' : 'jpeg'
      row.getCell(RECEIPT_COLUMN_INDEX + 1).value = ''
      const imageId = workbook.addImage({ base64: imageBuffer.toString('base64'), extension })
      sheet.addImage(imageId, {
        tl: { col: RECEIPT_COLUMN_INDEX + 0.1, row: row.number - 1 + imageIndex * slot + 0.02 },
        ext: RECEIPT_DISPLAY,
        editAs: 'oneCell',
      })
    }
  }

  // 合计
  const firstItemRow = 5
  const lastItemRow = 4 + items.length
  const totalRow = sheet.addRow([
    '合计：',
    '',
    '',
    { formula: `SUM(D${firstItemRow}:D${lastItemRow})` } as ExcelJS.CellValue,
    '',
    '',
  ])
  totalRow.getCell(4).numFmt = '#,##0.00'
  totalRow.getCell(1).font = { bold: true }
  totalRow.getCell(4).font = { bold: true }
  totalRow.getCell(4).alignment = { horizontal: 'right', vertical: 'middle' }
  totalRow.height = 22

  // 审批信息页脚
  const footer = sheet.addRow([])
  footer.height = 20
  const footerParts = [`状态：${STATUS_TEXT[data.status]}`]
  if (data.reviewed_at) {
    footerParts.push(`审批人：${displayProfileName(data.reviewer)} ${formatDate(data.reviewed_at, true)}`)
  }
  if (data.status === 'rejected' && data.reject_reason) {
    footerParts.push(`驳回原因：${data.reject_reason}`)
  }
  if (data.completed_at) {
    footerParts.push(`确认报销：${displayProfileName(data.completer)} ${formatDate(data.completed_at, true)}`)
  }
  sheet.mergeCells(`A${footer.number}:F${footer.number}`)
  footer.getCell(1).value = footerParts.join('　')
  footer.getCell(1).font = { size: 10, color: { argb: 'FF6B7280' } }

  const buffer = await workbook.xlsx.writeBuffer()
  const body = new Uint8Array(buffer as ArrayBuffer)
  const applicantName = displayProfileName(data.applicant) || '报销单'
  const fileName = `费用报销单_${applicantName}_${data.expense_date}.xlsx`
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="reimbursement-${data.expense_date}.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Content-Length': String(body.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
