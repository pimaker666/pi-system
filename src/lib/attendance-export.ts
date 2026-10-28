// 考勤表按月导出（ExcelJS，客户端下载）。
// 结构对齐页面：每人一行，上午/下午各一列 × 当月天数 + 符号汇总列 + 备注。

import type { Row } from 'exceljs'
import { ATTENDANCE_SYMBOLS, summarizeAttendance } from '@/lib/attendance'
import type { AttendanceEntry, AttendanceMember } from '@/types'

const DAY_SYMBOLS = ATTENDANCE_SYMBOLS.filter(({ kind }) => kind === 'day')
const TIME_SYMBOLS = ATTENDANCE_SYMBOLS.filter(({ kind }) => kind === 'times')

function monthLabel(month: string) {
  return `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`
}

function daysInMonth(month: string) {
  const year = Number(month.slice(0, 4))
  const monthIndex = Number(month.slice(5, 7))
  return new Date(year, monthIndex, 0).getDate()
}

const HEADER_FILL: Partial<import('exceljs').Fill> = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF1F5F9' },
}

export async function exportAttendanceSheet(input: {
  month: string
  note: string
  members: Pick<AttendanceMember, 'id' | 'name' | 'profile_id'>[]
  entries: Pick<AttendanceEntry, 'member_id' | 'day' | 'morning' | 'afternoon'>[]
}): Promise<void> {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'pi-system'
  const sheet = workbook.addWorksheet(monthLabel(input.month))

  const days = daysInMonth(input.month)
  const columns: { header: string; key: string; width: number }[] = [
    { header: '姓名', key: 'name', width: 12 },
  ]
  for (let day = 1; day <= days; day += 1) {
    columns.push({ header: `${day}日上午`, key: `m${day}`, width: 5 })
    columns.push({ header: `${day}日下午`, key: `a${day}`, width: 5 })
  }
  for (const { symbol, label } of [...DAY_SYMBOLS, ...TIME_SYMBOLS]) {
    columns.push({ header: `${symbol}${label}`, key: `s${symbol}`, width: 9 })
  }
  sheet.columns = columns

  const headerRow = sheet.getRow(1)
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL as import('exceljs').Fill
    cell.font = { bold: true }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
  })
  headerRow.height = 28
  sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }]

  const entryOf = (memberId: string, day: number) =>
    input.entries.find((entry) => entry.member_id === memberId && entry.day === day)

  for (const member of input.members) {
    const profileEntries = Array.from({ length: days }, (_, i) => {
      const day = i + 1
      const entry = entryOf(member.id, day)
      return { day, morning: entry?.morning ?? '', afternoon: entry?.afternoon ?? '' }
    })
    const summary = summarizeAttendance(profileEntries)
    const rowData: Record<string, string | number> = { name: member.name }
    for (let day = 1; day <= days; day += 1) {
      const entry = entryOf(member.id, day)
      rowData[`m${day}`] = entry?.morning ?? ''
      rowData[`a${day}`] = entry?.afternoon ?? ''
    }
    for (const { symbol } of ATTENDANCE_SYMBOLS) {
      rowData[`s${symbol}`] = summary.counts[symbol] ?? 0
    }
    const row = sheet.addRow(rowData)
    styleRow(row, days)
  }

  if (input.note.trim()) {
    sheet.addRow({})
    sheet.addRow({ name: `备注：${input.note.trim()}` })
  }

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

function styleRow(row: Row, days: number) {
  row.getCell(1).alignment = { vertical: 'middle' }
  for (let i = 2; i <= 1 + days * 2 + ATTENDANCE_SYMBOLS.length; i += 1) {
    row.getCell(i).alignment = { vertical: 'middle', horizontal: 'center' }
  }
}
