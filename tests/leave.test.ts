import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  formatLeaveHours,
  hourlyLeaveDayEquivalent,
  isValidHourlyLeave,
  MAX_HOURLY_LEAVE,
  WORKDAY_HOURS,
} from '../src/lib/leave.ts'

test('工作日口径为 7.5 小时', () => {
  assert.equal(WORKDAY_HOURS, 7.5)
})

test('小时假折算天数保留两位小数', () => {
  assert.equal(hourlyLeaveDayEquivalent(1), 0.13)
  assert.equal(hourlyLeaveDayEquivalent(3.5), 0.47)
  assert.equal(hourlyLeaveDayEquivalent(7.5), 1)
})

test('小时假上限：上午 3.0、下午 3.5', () => {
  assert.equal(MAX_HOURLY_LEAVE.morning, 3)
  assert.equal(MAX_HOURLY_LEAVE.afternoon, 3.5)
  assert.equal(isValidHourlyLeave(3, 'morning'), true)
  assert.equal(isValidHourlyLeave(3.5, 'morning'), false)
  assert.equal(isValidHourlyLeave(3.5, 'afternoon'), true)
  assert.equal(isValidHourlyLeave(4, 'afternoon'), false)
})

test('小时假必须 0.5 步进且大于 0', () => {
  assert.equal(isValidHourlyLeave(1.5, 'afternoon'), true)
  assert.equal(isValidHourlyLeave(1.3, 'afternoon'), false)
  assert.equal(isValidHourlyLeave(0, 'afternoon'), false)
  assert.equal(isValidHourlyLeave(-1, 'afternoon'), false)
})

test('小时数展示去掉多余的 .0', () => {
  assert.equal(formatLeaveHours(1), '1h')
  assert.equal(formatLeaveHours(0.5), '0.5h')
  assert.equal(formatLeaveHours(3.5), '3.5h')
})
