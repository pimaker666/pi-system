// 考勤表按月导出（ExcelJS，客户端下载）。
// 结构对齐页面：每人两行（上午/下午）、每天一列 + 符号汇总列，A4 横向一页缩放。

import type { Workbook, Worksheet } from 'exceljs'
import { ATTENDANCE_SYMBOLS, summarizeAttendance } from '@/lib/attendance'
import { formatLeaveHours } from '@/lib/leave'
import type { AttendanceEntry, AttendanceMember } from '@/types'

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

const SYMBOL_COLORS: Record<string, string> = {
  '√': 'FF059669',
  '●': 'FF64748B',
  '○': 'FFD97706',
  '☆': 'FF7C3AED',
  '△': 'FF2563EB',
  '▲': 'FF4F46E5',
  '×': 'FFDC2626',
  '※': 'FFEA580C',
  '◇': 'FFEA580C',
  '◆': 'FFC2410C',
}

const COLOR = {
  ink: 'FF0F172A',
  muted: 'FF64748B',
  subtle: 'FF94A3B8',
  white: 'FFFFFFFF',
  nameCell: 'FFF8FAFC',
  weekendCell: 'FFF1F5F9',
  header: 'FF0F172A',
  headerWeekend: 'FF334155',
  headerSummary: 'FF1E293B',
  border: 'FFE2E8F0',
  borderStrong: 'FF94A3B8',
  headerBorder: 'FF334155',
}

const FONT = '微软雅黑'

const thinBorder = { style: 'thin' as const, color: { argb: COLOR.border } }
const mediumBorder = { style: 'medium' as const, color: { argb: COLOR.borderStrong } }
const headerBottomBorder = { style: 'medium' as const, color: { argb: COLOR.headerBorder } }

function monthLabel(month: string) {
  return `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`
}

function daysInMonth(month: string) {
  const year = Number(month.slice(0, 4))
  const monthIndex = Number(month.slice(5, 7))
  return new Date(year, monthIndex, 0).getDate()
}

function weekdayOf(month: string, day: number) {
  const year = Number(month.slice(0, 4))
  const monthIndex = Number(month.slice(5, 7))
  return WEEKDAY_LABELS[new Date(year, monthIndex - 1, day).getDay()]
}

function isWeekend(month: string, day: number) {
  const weekday = weekdayOf(month, day)
  return weekday === '六' || weekday === '日'
}

function shanghaiNowLabel() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date())
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`
}

function solidFill(argb: string) {
  return { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } }
}

function formatCount(count: number) {
  if (!count) return ''
  return Number.isInteger(count) ? count : count.toFixed(1)
}

function styleHeaderCell(
  sheet: Worksheet,
  row: number,
  column: number,
  options: { fill: string; color: string; bottom?: 'medium' },
) {
  const cell = sheet.getCell(row, column)
  cell.fill = solidFill(options.fill)
  cell.font = { name: FONT, size: 9, bold: true, color: { argb: options.color } }
  cell.alignment = { horizontal: 'center', vertical: 'middle' }
  cell.border = {
    left: thinBorder,
    right: thinBorder,
    top: thinBorder,
    bottom: options.bottom === 'medium' ? headerBottomBorder : thinBorder,
  }
}

function buildWorkbook(workbook: Workbook, input: Parameters<typeof exportAttendanceSheet>[0]) {
  const sheet = workbook.addWorksheet(`${monthLabel(input.month)}考勤表`, {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 5, showGridLines: false }],
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '4:5',
      printTitlesColumn: 'A:B',
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
    headerFooter: { oddFooter: '&C第 &P 页 / 共 &N 页' },
    properties: { defaultRowHeight: 18, tabColor: { argb: COLOR.header } },
  })

  const days = daysInMonth(input.month)
  const dayColumns = days
  const summaryColumns = ATTENDANCE_SYMBOLS.length
  const lastColumn = 2 + dayColumns + summaryColumns + 1

  sheet.columns = [
    { key: 'name', width: 10 },
    { key: 'half', width: 7 },
    ...Array.from({ length: dayColumns }, (_, index) => ({ key: `d${index + 1}`, width: 3.4 })),
    ...ATTENDANCE_SYMBOLS.map(({ symbol }) => ({ key: `s${symbol}`, width: 6.8 })),
    { key: 'hourly', width: 7.4 },
  ]

  sheet.mergeCells(1, 1, 1, lastColumn)
  const title = sheet.getCell(1, 1)
  title.value = `${monthLabel(input.month)}考勤表`
  title.font = { name: FONT, size: 18, bold: true, color: { argb: COLOR.ink } }
  title.alignment = { horizontal: 'left', vertical: 'middle' }
  sheet.getRow(1).height = 34

  const subtitleParts = [
    `导出时间：${shanghaiNowLabel()}`,
    `人数：${input.members.length} 人`,
  ]
  if (input.note.trim()) subtitleParts.push(`备注：${input.note.trim()}`)
  sheet.mergeCells(2, 1, 2, lastColumn)
  const subtitle = sheet.getCell(2, 1)
  subtitle.value = subtitleParts.join('    ')
  subtitle.font = { name: FONT, size: 10, color: { argb: 'FF475569' } }
  subtitle.alignment = { horizontal: 'left', vertical: 'middle' }
  subtitle.fill = solidFill(COLOR.nameCell)
  sheet.getRow(2).height = 20
  sheet.getRow(3).height = 6

  sheet.mergeCells(4, 1, 5, 1)
  sheet.mergeCells(4, 2, 5, 2)
  sheet.getCell(4, 1).value = '姓名'
  sheet.getCell(4, 2).value = '上/下午'
  for (const column of [1, 2]) {
    const cell = sheet.getCell(4, column)
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: COLOR.white } }
    cell.fill = solidFill(COLOR.header)
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
    cell.border = {
      left: thinBorder,
      right: thinBorder,
      top: thinBorder,
      bottom: headerBottomBorder,
    }
  }

  for (let day = 1; day <= days; day += 1) {
    const column = 2 + day
    const weekend = isWeekend(input.month, day)
    const weekdayCell = sheet.getCell(4, column)
    weekdayCell.value = weekdayOf(input.month, day)
    const dayCell = sheet.getCell(5, column)
    dayCell.value = day
    for (const row of [4, 5]) {
      styleHeaderCell(sheet, row, column, {
        fill: weekend ? COLOR.headerWeekend : COLOR.header,
        color: weekend ? 'FFCBD5E1' : 'FFF8FAFC',
        bottom: 'medium',
      })
    }
  }

  ATTENDANCE_SYMBOLS.forEach(({ symbol, label }, index) => {
    const column = 2 + dayColumns + 1 + index
    sheet.mergeCells(4, column, 5, column)
    const cell = sheet.getCell(4, column)
    cell.value = `${symbol}\n${label}`
    cell.font = {
      name: FONT,
      size: 9,
      bold: true,
      color: { argb: symbol === '√' || symbol === '●' ? 'FFE2E8F0' : 'FFFDE68A' },
    }
    cell.fill = solidFill(COLOR.headerSummary)
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    cell.border = {
      left: index === 0 ? mediumBorder : thinBorder,
      right: thinBorder,
      top: thinBorder,
      bottom: headerBottomBorder,
    }
  })
  const hourlyHeaderColumn = 2 + dayColumns + summaryColumns + 1
  sheet.mergeCells(4, hourlyHeaderColumn, 5, hourlyHeaderColumn)
  const hourlyHeader = sheet.getCell(4, hourlyHeaderColumn)
  hourlyHeader.value = '小时假\n小时'
  hourlyHeader.font = {
    name: FONT,
    size: 9,
    bold: true,
    color: { argb: 'FFFDE68A' },
  }
  hourlyHeader.fill = solidFill(COLOR.headerSummary)
  hourlyHeader.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  hourlyHeader.border = {
    left: thinBorder,
    right: mediumBorder,
    top: thinBorder,
    bottom: headerBottomBorder,
  }
  sheet.getRow(4).height = 20
  sheet.getRow(5).height = 20

  const entryOf = (memberId: string, day: number) =>
    input.entries.find((entry) => entry.member_id === memberId && entry.day === day)

  let rowIndex = 6
  for (const member of input.members) {
    const summary = summarizeAttendance(
      Array.from({ length: days }, (_, index) => {
        const entry = entryOf(member.id, index + 1)
        return {
          day: index + 1,
          morning: entry?.morning ?? '',
          afternoon: entry?.afternoon ?? '',
          morning_leave_hours: Number(entry?.morning_leave_hours ?? 0),
          afternoon_leave_hours: Number(entry?.afternoon_leave_hours ?? 0),
        }
      }),
    )
    const top = rowIndex
    const bottom = rowIndex + 1

    sheet.mergeCells(top, 1, bottom, 1)
    const nameCell = sheet.getCell(top, 1)
    nameCell.value = member.name
    nameCell.font = { name: FONT, size: 10, bold: true, color: { argb: COLOR.ink } }
    nameCell.fill = solidFill(COLOR.nameCell)
    nameCell.alignment = { horizontal: 'center', vertical: 'middle' }
    nameCell.border = {
      left: thinBorder,
      right: thinBorder,
      top: thinBorder,
      bottom: mediumBorder,
    }

    ;(['上午', '下午'] as const).forEach((label, halfIndex) => {
      const row = top + halfIndex
      const halfCell = sheet.getCell(row, 2)
      halfCell.value = label
      halfCell.font = { name: FONT, size: 9, color: { argb: COLOR.muted } }
      halfCell.fill = solidFill(COLOR.nameCell)
      halfCell.alignment = { horizontal: 'center', vertical: 'middle' }
      halfCell.border = {
        left: thinBorder,
        right: thinBorder,
        top: thinBorder,
        bottom: halfIndex === 1 ? mediumBorder : thinBorder,
      }

      for (let day = 1; day <= days; day += 1) {
        const entry = entryOf(member.id, day)
        const rawValue = (halfIndex === 0 ? entry?.morning : entry?.afternoon) ?? ''
        const hours =
          halfIndex === 0
            ? Number(entry?.morning_leave_hours ?? 0)
            : Number(entry?.afternoon_leave_hours ?? 0)
        const value = rawValue === '√' && hours > 0 ? `√${formatLeaveHours(hours)}` : rawValue
        const cell = sheet.getCell(row, 2 + day)
        cell.value = value
        cell.font = {
          name: FONT,
          size: 10,
          bold: Boolean(rawValue && !['√', '●'].includes(rawValue)),
          color: { argb: rawValue ? (SYMBOL_COLORS[rawValue] ?? COLOR.ink) : 'FFCBD5E1' },
        }
        cell.alignment = { horizontal: 'center', vertical: 'middle' }
        cell.fill = solidFill(isWeekend(input.month, day) ? COLOR.weekendCell : COLOR.white)
        cell.border = {
          left: thinBorder,
          right: thinBorder,
          top: thinBorder,
          bottom: halfIndex === 1 ? mediumBorder : thinBorder,
        }
      }
    })

    ATTENDANCE_SYMBOLS.forEach(({ symbol }, index) => {
      const column = 2 + dayColumns + 1 + index
      sheet.mergeCells(top, column, bottom, column)
      const cell = sheet.getCell(top, column)
      const count = summary.counts[symbol] ?? 0
      cell.value = formatCount(count)
      cell.font = {
        name: FONT,
        size: 10,
        color: { argb: count ? 'FF334155' : 'FFCBD5E1' },
      }
      cell.alignment = { horizontal: 'center', vertical: 'middle' }
      cell.fill = solidFill(COLOR.white)
      cell.border = {
        left: index === 0 ? mediumBorder : thinBorder,
        right: thinBorder,
        top: thinBorder,
        bottom: mediumBorder,
      }
    })

    sheet.mergeCells(top, hourlyHeaderColumn, bottom, hourlyHeaderColumn)
    const hourlyCell = sheet.getCell(top, hourlyHeaderColumn)
    hourlyCell.value =
      summary.hourlyLeaveHours > 0 ? formatLeaveHours(summary.hourlyLeaveHours) : ''
    hourlyCell.font = {
      name: FONT,
      size: 10,
      color: { argb: summary.hourlyLeaveHours > 0 ? 'FFB45309' : 'FFCBD5E1' },
    }
    hourlyCell.alignment = { horizontal: 'center', vertical: 'middle' }
    hourlyCell.fill = solidFill(COLOR.white)
    hourlyCell.border = {
      left: thinBorder,
      right: mediumBorder,
      top: thinBorder,
      bottom: mediumBorder,
    }

    rowIndex += 2
  }

  if (input.members.length === 0) {
    sheet.mergeCells(6, 1, 6, lastColumn)
    const empty = sheet.getCell(6, 1)
    empty.value = '本月暂无考勤人员'
    empty.font = { name: FONT, size: 10, color: { argb: COLOR.muted } }
    empty.alignment = { horizontal: 'center', vertical: 'middle' }
    rowIndex = 7
  }

  const legendRow = rowIndex + 1
  sheet.mergeCells(legendRow, 1, legendRow, lastColumn)
  const legend = sheet.getCell(legendRow, 1)
  legend.value = `图例：${ATTENDANCE_SYMBOLS.map(({ symbol, label }) => `${symbol} ${label}`).join('   ')}`
  legend.font = { name: FONT, size: 9, color: { argb: 'FF475569' } }
  legend.alignment = { horizontal: 'left', vertical: 'middle' }

  sheet.mergeCells(legendRow + 1, 1, legendRow + 1, lastColumn)
  const note = sheet.getCell(legendRow + 1, 1)
  note.value =
    '说明：天数字段按上午/下午各计 0.5 天；√ 后带小时数（如 √1h）表示该半天有小时假，1 小时 = 1/7.5 天；空白表示未标记。'
  note.font = { name: FONT, size: 9, color: { argb: COLOR.subtle } }
  note.alignment = { horizontal: 'left', vertical: 'middle' }
}

export async function exportAttendanceSheet(input: {
  month: string
  note: string
  members: Pick<AttendanceMember, 'id' | 'name' | 'profile_id'>[]
  entries: Pick<
    AttendanceEntry,
    'member_id' | 'day' | 'morning' | 'afternoon' | 'morning_leave_hours' | 'afternoon_leave_hours'
  >[]
}): Promise<void> {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'pi-system'
  buildWorkbook(workbook, input)

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `考勤表_${monthLabel(input.month)}.xlsx`
  anchor.click()
  URL.revokeObjectURL(url)
}
