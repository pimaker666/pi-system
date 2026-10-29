import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  summarizeAttendance,
  isAttendanceSymbol,
  ATTENDANCE_SYMBOLS,
} from '../src/lib/attendance.ts'

const ALL_ZERO = Object.fromEntries(ATTENDANCE_SYMBOLS.map((s) => [s.symbol, 0]))

test('空记录时所有符号计数为 0', () => {
  assert.deepEqual(summarizeAttendance([]).counts, ALL_ZERO)
})

test('上下午同符号一天只计 1 天', () => {
  const { counts } = summarizeAttendance([
    { day: 1, morning: '√', afternoon: '√' },
  ])
  assert.equal(counts['√'], 1)
})

test('上/下午各 0.5 天（陈宇恒 10/8 半天请假场景）', () => {
  const { counts } = summarizeAttendance([
    { day: 8, morning: '○', afternoon: '√' },
  ])
  assert.equal(counts['○'], 0.5)
  assert.equal(counts['√'], 0.5)
})

test('半天符号跨多天累加', () => {
  const { counts } = summarizeAttendance([
    { day: 8, morning: '○', afternoon: '√' },
    { day: 9, morning: '○', afternoon: '○' },
  ])
  assert.equal(counts['○'], 1.5)
  assert.equal(counts['√'], 0.5)
})

test('次数类符号按格子计次，同天两次算 2 次', () => {
  const { counts } = summarizeAttendance([
    { day: 3, morning: '※', afternoon: '※' },
    { day: 4, morning: '※', afternoon: '' },
  ])
  assert.equal(counts['※'], 3)
})

test('空白与未知符号不计数', () => {
  const { counts } = summarizeAttendance([
    { day: 1, morning: '', afternoon: '' },
    { day: 2, morning: '?', afternoon: '√' },
  ])
  assert.equal(counts['√'], 0.5)
  assert.equal(counts['○'], 0)
})

test('天数类同一 entry 内封顶 1 天，跨 entry 独立累加', () => {
  const { counts } = summarizeAttendance([
    { day: 1, morning: '√', afternoon: '√' },
    { day: 1, morning: '√', afternoon: '' },
  ])
  assert.equal(counts['√'], 1.5)
})

test('isAttendanceSymbol 校验', () => {
  assert.equal(isAttendanceSymbol('√'), true)
  assert.equal(isAttendanceSymbol('?'), false)
  assert.equal(isAttendanceSymbol(''), false)
})
