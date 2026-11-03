import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseDelimitedMatrix, parseStatementRows } from '../src/lib/journal-import.ts'

test('中行合并摘要列：借/贷两列识别方向，用途不当作流水号', () => {
  const rows = parseStatementRows([
    ['中国银行交易流水明细清单'],
    ['序号', '记账日', '交易类型', '凭证号码/业务编号/用途/摘要', '借方发生额', '贷方发生额', '余额', '备注'],
    [1, '2026-09-01', '转账', 'IBPS/网银转账/货款', null, 1000, 1000, '张三'],
    [2, '2026/9/2', '转账', 'IBPS/网银转账/采购款', 250.5, null, 749.5, '李四'],
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].entry_date, '2026-09-01')
  assert.equal(rows[0].kind, 'income')
  assert.equal(rows[0].amount_original, 1000)
  assert.equal(rows[0].counterparty, '张三')
  assert.equal(rows[0].reference_no, undefined)
  assert.equal(rows[1].entry_date, '2026-09-02')
  assert.equal(rows[1].kind, 'expense')
  assert.equal(rows[1].amount_original, 250.5)
})

test('单金额列：按借贷标志判断收支', () => {
  const rows = parseStatementRows([
    ['交易日', '交易金额', '借贷标志', '摘要', '对方户名', '交易流水号'],
    ['2026-09-05', '1,200.00', '贷', '货款', '王五', '20260905001'],
    ['2026-09-06', '300.00', '借', '采购', '赵六', '20260906002'],
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].kind, 'income')
  assert.equal(rows[0].amount_original, 1200)
  assert.equal(rows[1].kind, 'expense')
  assert.equal(rows[1].reference_no, '20260906002')
})

test('单金额列：无标志时负数视为支出，括号金额同样识别', () => {
  const rows = parseStatementRows([
    ['日期', '交易金额', '摘要'],
    ['2026-09-07', -88.5, '手续费'],
    ['2026-09-08', '(12.00)', '短信费'],
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].kind, 'expense')
  assert.equal(rows[0].amount_original, 88.5)
  assert.equal(rows[1].amount_original, 12)
})

test('Excel 日期序列号按 UTC 还原', () => {
  const rows = parseStatementRows([
    ['日期', '交易金额', '借贷标志', '摘要'],
    [45209, 88, '收入', '测试'],
  ])
  assert.equal(rows[0].entry_date, '2023-10-10')
})

test('制表符文本：标题行不影响分隔符判断', () => {
  const matrix = parseDelimitedMatrix('账户明细\n日期\t交易金额\t借贷标志\t摘要\n2026-09-10\t10\t收入\t利息')
  const rows = parseStatementRows(matrix)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'income')
  assert.equal(rows[0].amount_original, 10)
})
