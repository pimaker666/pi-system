import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  calcPayroll,
  countWeekdays,
  calcAttendanceDeduction,
} from '../src/lib/payroll.ts'

test('calcPayroll 应发=底薪+提成+奖金-考勤扣款', () => {
  const r = calcPayroll({
    base_salary: 5000,
    commission: 1000,
    bonus: 500,
    attendance_deduction: 227.27,
    other_deduction: 100,
    social_insurance: 500,
    housing_fund: 300,
    tax: 200,
  })
  assert.equal(r.gross, 6272.73)
  assert.equal(r.totalDeduction, 1100)
  assert.equal(r.net, 5172.73)
})

test('calcPayroll 空值字段按 0 处理', () => {
  const r = calcPayroll({
    base_salary: 0,
    commission: 0,
    bonus: 0,
    attendance_deduction: 0,
    other_deduction: 0,
    social_insurance: 0,
    housing_fund: 0,
    tax: 0,
  })
  assert.deepEqual(r, { gross: 0, totalDeduction: 0, net: 0 })
})

test('countWeekdays 2026-10 有 22 个工作日（1 日周四、31 日周六）', () => {
  assert.equal(countWeekdays('2026-10'), 22)
})

test('countWeekdays 2026-11 有 21 个工作日', () => {
  assert.equal(countWeekdays('2026-11'), 21)
})

test('countWeekdays 兼容带日期的期间字符串', () => {
  assert.equal(countWeekdays('2026-10-29'), 22)
})

test('满勤天数为空或 <=0 时不扣款', () => {
  assert.equal(calcAttendanceDeduction(5000, null, 10), 0)
  assert.equal(calcAttendanceDeduction(5000, 0, 10), 0)
})

test('出勤满勤时不扣款', () => {
  assert.equal(calcAttendanceDeduction(5000, 22, 22), 0)
  assert.equal(calcAttendanceDeduction(5000, 22, 23), 0)
})

test('缺勤 1 天扣款=底薪/满勤天数（四舍五入 2 位）', () => {
  assert.equal(calcAttendanceDeduction(5000, 22, 21), 227.27)
})

test('缺勤半天按 0.5 天计（与考勤表口径一致）', () => {
  assert.equal(calcAttendanceDeduction(5000, 22, 21.5), 113.64)
})
