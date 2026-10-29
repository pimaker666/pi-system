/**
 * 校验业绩页两板块（分组汇总 / 多维销售总览）导出接口：
 *   1. 正常负载 → xlsx 表头、整数格式、合计行加粗、autoFilter、文件名；
 *   2. 行长度与列数不一致 → 400；
 *   3. 空数据 → 400；
 *   4. 非法负载（多余字段 / 非数字单元格）→ 400。
 *
 * 运行：NODE_PATH=... ELECTRON_RUN_AS_NODE=1 <Qoder> scripts/verify-performance-export.cjs
 */
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')
const ExcelJS = require('exceljs')

const REPO = path.resolve(__dirname, '..')
const ROUTE = 'src/app/api/finance/performance/export/xlsx/route.ts'

const SHIMS = {
  '@/lib/auth': 'export async function requireApproved() { return { id: "u1", role: "admin" } }',
  '@/lib/daily-order-costs-server': 'export function chinaToday() { return "2026-10-29" }',
}

const aliasPlugin = {
  name: 'alias',
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      if (SHIMS[args.path]) return { path: args.path, namespace: 'shim' }
      const base = path.join(REPO, 'src', args.path.slice(2))
      for (const ext of ['.ts', '.tsx', '.js', '/index.ts', '/index.tsx']) {
        const candidate = base + ext
        if (fs.existsSync(candidate)) return { path: candidate }
      }
      return { path: base + '.ts' }
    })
    build.onLoad({ filter: /.*/, namespace: 'shim' }, (args) => ({
      contents: SHIMS[args.path],
      loader: 'ts',
    }))
  },
}

// next/server 最小替身：只实现 NextResponse.json / new NextResponse(body, { headers })
class ShimNextResponse {
  constructor(body, init) {
    this.body = body
    this.status = init?.status ?? 200
    this.headers = new Map(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  }
  async json() {
    return typeof this.body === 'string' ? JSON.parse(this.body) : this.body
  }
  async arrayBuffer() {
    const bytes = this.body instanceof Uint8Array ? this.body : new Uint8Array()
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
  static json(data, init) {
    return new ShimNextResponse(JSON.stringify(data), init)
  }
}

async function loadRoute() {
  const result = await esbuild.build({
    entryPoints: [path.join(REPO, ROUTE)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    plugins: [aliasPlugin],
    external: ['next/server', 'exceljs'],
    logLevel: 'silent',
  })
  const mod = { exports: {} }
  const shimRequire = (id) => {
    if (id === 'next/server') return { NextResponse: ShimNextResponse }
    return require(id)
  }
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(
    mod,
    mod.exports,
    shimRequire,
  )
  return mod.exports
}

function post(route, payload) {
  return route.POST(
    new Request('http://localhost/api/finance/performance/export/xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

async function parseWorkbook(response) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await response.arrayBuffer())
  return workbook
}

function cellText(cell) {
  const value = cell.value
  if (value && typeof value === 'object' && 'richText' in value) {
    return value.richText.map((part) => part.text).join('')
  }
  return value
}

const products = [
  { name: 'Facial Cleanser', sku: 'FC-01', qty: 120, amount: 1234.5, avg: 10.29 },
  { name: 'Serum 30ml', sku: null, qty: 8, amount: 99.5, avg: 12.44 },
]

const groupPayload = {
  fileName: '业务业绩_业务_2026-10-01至2026-10-31',
  sheetName: '业务业绩',
  columns: ['业务', '订单数', '订单总额（CNY）', '已收（CNY）', '未收（CNY）', '逾期订单'],
  rows: [
    ['Alice', 12, 12345, 9000.4, 3345, 2],
    ['Bob', 3, 99.5, 99.5, 0, 0],
  ],
  totalRow: ['合计', '—', 12444.5, 9099.9, 3345, 2],
}

const multiPayload = {
  fileName: '多维销售总览_业务_渠道_2026-10',
  sheetName: '多维销售总览',
  columns: ['业务', '渠道', '订单数', '销售数量', '产品销售额（不含运费，CNY）', '产品销售额（不含运费，USD）'],
  rows: [
    ['Alice', 'Amazon', 7, 128, 12345.4, 1700.2],
    ['Bob', 'Shopify', 2, 6, 99.5, 13.9],
  ],
}

async function main() {
  const route = await loadRoute()
  assert.strictEqual(typeof route.POST, 'function', '路由缺少 POST')
  assert.strictEqual(route.GET, undefined, '导出接口应为 POST-only')

  // 1) 分组汇总表（带合计行）
  const groupResponse = await post(route, groupPayload)
  assert.strictEqual(groupResponse.status, 200, '分组汇总导出应返回 200')
  assert.match(
    groupResponse.headers.get('content-type') ?? '',
    /spreadsheetml\.sheet/,
    'Content-Type 应为 xlsx',
  )
  const disposition = groupResponse.headers.get('content-disposition') ?? ''
  assert.match(disposition, /attachment; filename="performance-2026-10-29\.xlsx"/, '缺少 ASCII 文件名')
  assert.ok(
    disposition.includes(encodeURIComponent('业务业绩_业务_2026-10-01至2026-10-31.xlsx')),
    `UTF-8 文件名未按原始中文编码：${disposition}`,
  )
  assert.strictEqual(groupResponse.headers.get('cache-control'), 'no-store')

  const groupBook = await parseWorkbook(groupResponse)
  const groupSheet = groupBook.getWorksheet('业务业绩')
  assert.ok(groupSheet, '缺少名为「业务业绩」的工作表')
  assert.deepStrictEqual(
    groupSheet.getRow(1).values.slice(1),
    groupPayload.columns,
    '表头与提交的列名不一致',
  )
  assert.strictEqual(groupSheet.getRow(1).getCell(1).fill.fgColor.argb, 'FF1D4ED8', '表头底色应为品牌蓝')
  assert.strictEqual(groupSheet.getRow(1).getCell(1).font.bold, true, '表头应加粗')
  const frozen = groupSheet.views?.[0]
  assert.strictEqual(frozen?.state, 'frozen', '表头应冻结')
  assert.strictEqual(frozen?.ySplit, 1, '表头应冻结首行')

  // 数字单元格统一整数格式；字符串 / 空值保持原样
  for (const rowNumber of [2, 3, 4]) {
    const row = groupSheet.getRow(rowNumber)
    const expected = rowNumber === 2 ? groupPayload.rows[0] : rowNumber === 3 ? groupPayload.rows[1] : groupPayload.totalRow
    expected.forEach((value, index) => {
      const cell = row.getCell(index + 1)
      assert.strictEqual(cellText(cell), value, `第 ${rowNumber} 行第 ${index + 1} 列内容不符`)
      if (typeof value === 'number') {
        assert.strictEqual(cell.numFmt, '#,##0', `第 ${rowNumber} 行第 ${index + 1} 列小数位格式应为整数`)
      }
    })
  }
  assert.strictEqual(groupSheet.getRow(4).getCell(1).font.bold, true, '合计行应加粗')
  assert.strictEqual(groupSheet.getRow(4).getCell(1).value, '合计', '合计行首列应为「合计」')
  assert.strictEqual(groupSheet.getRow(4).getCell(2).value, '—', '合计行的订单数应保留占位符')
  // ExcelJS 读回后 autoFilter 是 "A1:F3" 这样的区间字符串
  const autoFilter = groupSheet.autoFilter
  const filterEnd = groupPayload.rows.length + 1
  const inRange =
    typeof autoFilter === 'string'
      ? autoFilter === `A1:F${filterEnd}`
      : autoFilter?.to?.row === filterEnd
  assert.ok(inRange, `autoFilter 应只覆盖表头与数据行（不含合计），实际 ${JSON.stringify(autoFilter)}`)

  // 2) 多维销售总览（无合计行）
  const multiResponse = await post(route, multiPayload)
  assert.strictEqual(multiResponse.status, 200, '多维总览导出应返回 200')
  const multiBook = await parseWorkbook(multiResponse)
  const multiSheet = multiBook.getWorksheet('多维销售总览')
  assert.ok(multiSheet, '缺少名为「多维销售总览」的工作表')
  assert.deepStrictEqual(multiSheet.getRow(1).values.slice(1), multiPayload.columns)
  assert.strictEqual(multiSheet.getRow(2).getCell(4).numFmt, '#,##0', '销售数量应为整数格式')
  assert.strictEqual(multiSheet.rowCount, 3, '多维总览不应出现多余的空行')
  assert.ok(
    (multiResponse.headers.get('content-disposition') ?? '').includes(
      encodeURIComponent('多维销售总览_业务_渠道_2026-10.xlsx'),
    ),
    'UTF-8 文件名未按原始中文编码',
  )

  // 3) 行长度与列数不一致
  const mismatch = await post(route, { ...groupPayload, rows: [['Alice', 1]] })
  assert.strictEqual(mismatch.status, 400, '行长度不一致应拒绝')
  assert.strictEqual((await mismatch.json()).error, '导出列与数据不一致')

  // 4) 空数据
  const empty = await post(route, { ...multiPayload, rows: [] })
  assert.strictEqual(empty.status, 400, '空数据应拒绝')
  assert.strictEqual((await empty.json()).error, '当前筛选范围没有可导出的数据')

  // 5) 非法负载：多余字段 / 非法单元格 / 超长列
  const extra = await post(route, { ...multiPayload, sheetRows: 1 })
  assert.strictEqual(extra.status, 400, '.strict() 应拒绝多余字段')
  const badCell = await post(route, { ...multiPayload, rows: [[{ nested: true }]] })
  assert.strictEqual(badCell.status, 400, '对象单元格应拒绝')
  const tooManyColumns = await post(route, {
    ...multiPayload,
    columns: Array.from({ length: 21 }, (_, i) => `列${i}`),
  })
  assert.strictEqual(tooManyColumns.status, 400, '超过 20 列应拒绝')
  const notJson = await route.POST(
    new Request('http://localhost/x', { method: 'POST', body: 'not-json' }),
  )
  assert.strictEqual(notJson.status, 400, '非 JSON 请求应返回 400 而不是 500')

  console.log('✔ 业绩导出接口校验通过：')
  console.log(`  · 分组汇总：${groupPayload.rows.length} 行 + 合计行，数字格式 #,##0，表头冻结 & autoFilter 到第 ${groupPayload.rows.length + 1} 行`)
  console.log(`  · 多维总览：${multiPayload.rows.length} 行，中文文件名按 UTF-8 编码正确`)
  console.log('  · 异常负载（行长度 / 空数据 / 多余字段 / 对象单元格 / 超列 / 非 JSON）均返回 400')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
