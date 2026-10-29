import { test } from 'node:test'
import assert from 'node:assert/strict'

import { round2, calcLineTotal, calcPiTotals } from '../src/lib/calc.ts'

test('round2 实为 4 位小数并消除浮点漂移', () => {
  assert.equal(round2(0.1 + 0.2), 0.3)
  assert.equal(round2(1.23456), 1.2346)
  assert.equal(round2(1.23454), 1.2345)
})

test('calcLineTotal 空值按 0', () => {
  assert.equal(calcLineTotal(null, 3), 0)
  assert.equal(calcLineTotal(10, null), 0)
  assert.equal(calcLineTotal(10.1, 3), 30.3)
})

test('calcPiTotals 无折扣无税', () => {
  const r = calcPiTotals(
    [{ unit_price: 100, quantity: 2 }],
    { discount: 0, tax_rate: 0, shipping_fee: 0 },
  )
  assert.deepEqual(r, { subtotal: 200, tax_amount: 0, total: 200 })
})

test('calcPiTotals 折扣封顶不超过小计，超额折扣吃掉应税基数', () => {
  const r = calcPiTotals(
    [{ unit_price: 100, quantity: 1 }],
    { discount: 500, tax_rate: 10, shipping_fee: 0 },
  )
  assert.equal(r.subtotal, 100)
  assert.equal(r.tax_amount, 0)
  assert.equal(r.total, 0)
})

test('calcPiTotals 含税含运费', () => {
  const r = calcPiTotals(
    [
      { unit_price: 100, quantity: 2 },
      { unit_price: 50, quantity: 1 },
    ],
    { discount: 20, tax_rate: 10, shipping_fee: 15 },
  )
  assert.equal(r.subtotal, 250)
  assert.equal(r.tax_amount, 23)
  assert.equal(r.total, 268)
})
