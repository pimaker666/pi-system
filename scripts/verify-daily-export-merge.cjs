/**
 * 验证每日订单导出的两项改动：
 *   1. 截图上限提到 1000 张 / 400MB（每日订单与订单成本共用同一组常量）；
 *   2. 同一订单的多行产品在「订单总金额」列纵向合并，单行订单不合并。
 *
 * 直接跑导出路由（POST），mock 掉鉴权、台账读取与 Supabase Storage，
 * 再用 ExcelJS 读回生成的 xlsx 检查合并区间与图片锚点。
 * 同时把 HEAD 版本一并装配做差分，确认断言能识别出改动前的行为。
 *
 * 运行：NODE_PATH=<主工作区>/node_modules ELECTRON_RUN_AS_NODE=1 <Qoder> scripts/verify-daily-export-merge.cjs
 */
const assert = require('node:assert')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const ExcelJS = require('exceljs')
const esbuild = require('esbuild')

const REPO = path.resolve(__dirname, '..')
const ROUTE = 'src/app/api/finance/daily-orders/export/xlsx/route.ts'

const SHIMS = {
  '@/lib/auth': 'export async function requireApproved() {}',
  '@/lib/supabase/server': 'export async function createClient() { return globalThis.__mockClient }',
  '@/lib/business-daily-orders-server': `
    export const BUSINESS_DAILY_EXPORT_LIMIT = 2000
    export async function fetchBusinessDailyLedger() { return globalThis.__orders }
    export async function fetchSettledItemIdsForOrders() { return [] }
    export async function fetchConfirmedCommissionItemIdsForOrders() { return [] }
  `,
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

class ShimNextResponse {
  constructor(body, init = {}) {
    this.status = init.status ?? 200
    this.body = body
    const headers = new Map()
    for (const [key, value] of Object.entries(init.headers ?? {})) headers.set(key.toLowerCase(), value)
    this.headers = headers
  }
  static json(payload, init = {}) {
    return new ShimNextResponse(new TextEncoder().encode(JSON.stringify(payload)), init)
  }
}

async function loadRoute(tsSource) {
  const result = await esbuild.build({
    stdin: { contents: tsSource, resolveDir: REPO, loader: 'ts' },
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

// 1x1 透明 PNG：结构完整，能通过 isRenderableExportImage 的 IDAT 校验。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const mockClient = {
  storage: {
    from() {
      return {
        async download(objectPath) {
          if (objectPath.includes('missing')) return { data: null, error: new Error('not found') }
          return {
            data: {
              async arrayBuffer() {
                return PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength)
              },
            },
            error: null,
          }
        },
      }
    },
  },
}

function item(id, overrides = {}) {
  return {
    id,
    product_id: `p-${id}`,
    custom_product_id: null,
    sku_snapshot: `SKU-${id}`,
    name_snapshot: `产品-${id}`,
    image_url_snapshot: null,
    quantity: 1,
    unit_price: 100,
    line_amount: 100,
    product_received_amount: 100,
    logistics_fee_amount: 0,
    sales_total_amount: 100,
    daily_shipping_category: 'stock',
    sort_order: 1,
    created_at: '2026-10-01T00:00:00Z',
    ...overrides,
  }
}

let attachmentSeq = 0
function attachment() {
  attachmentSeq += 1
  return {
    id: `att-${attachmentSeq}`,
    object_path: `shot-${attachmentSeq}.png`,
    mime_type: 'image/png',
    size_bytes: 1000,
    status: 'active',
  }
}

function order(id, total, currency, items, attachments) {
  return {
    id,
    order_number: `BO-${id}`,
    order_date: '2026-10-05',
    external_order_number: null,
    shop_name_snapshot: '店A',
    salesperson_name_snapshot: '张三',
    salesperson: null,
    daily_shipping_number: null,
    daily_shipping_date: null,
    payment_account: '账户A',
    total_amount: total,
    currency,
    outstanding_amount: 0,
    daily_payment_category: 'full',
    sales_notes: '',
    business_order_items: items,
    business_order_attachments: attachments,
    business_order_shipments: [],
    business_order_returns: [],
    business_order_payment_allocations: [],
  }
}

function baseFixture() {
  attachmentSeq = 0
  return [
    // 3 行产品 → 第 2-4 行，订单总金额应合并
    order('A', 1000, 'CNY', [item('a1'), item('a2'), item('a3')], [attachment(), attachment()]),
    // 单行订单 → 不合并
    order('B', 200, 'CNY', [item('b1')], []),
    // 2 行产品 → 第 6-7 行，应合并（USD）
    order('C', 300, 'USD', [item('c1'), item('c2')], [attachment()]),
    // 无产品明细 → 单行占位，不合并
    order('D', 50, 'CNY', [], []),
  ]
}

async function exportXlsx(route, orders) {
  globalThis.__orders = orders
  globalThis.__mockClient = mockClient
  const request = new Request('http://localhost/api/finance/daily-orders/export/xlsx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filterQuery: '', ids: [] }),
  })
  return route.POST(request)
}

async function readSheet(response) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(response.body))
  return workbook
}

async function main() {
  const current = await loadRoute(fs.readFileSync(path.join(REPO, ROUTE), 'utf8'))
  const head = await loadRoute(
    execFileSync('git', ['-C', REPO, 'show', `HEAD:${ROUTE}`], { encoding: 'utf8' }),
  )

  // --- 1. 常量 -------------------------------------------------------------
  const libSource = fs.readFileSync(path.join(REPO, 'src/lib/business-daily-orders.ts'), 'utf8')
  const result = await esbuild.build({
    stdin: { contents: libSource, resolveDir: REPO, loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    plugins: [aliasPlugin],
    logLevel: 'silent',
  })
  const libMod = { exports: {} }
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(libMod, libMod.exports, require)
  assert.equal(libMod.exports.BUSINESS_DAILY_EXPORT_MAX_IMAGES, 1000, '截图上限应为 1000 张')
  assert.equal(
    libMod.exports.BUSINESS_DAILY_EXPORT_MAX_IMAGE_BYTES,
    400 * 1024 * 1024,
    '截图体积上限应为 400MB',
  )
  assert.equal(libMod.exports.BUSINESS_DAILY_EXPORT_MAX_IMAGES_PER_ORDER, 10, '单订单截图上限不变')

  // --- 2. 合并区间（当前实现） ---------------------------------------------
  const orders = baseFixture()
  const response = await exportXlsx(current, orders)
  assert.equal(response.status, 200, '正常导出应返回 200')
  const workbook = await readSheet(response)
  const sheet = workbook.getWorksheet('每日订单台账')
  const merges = sheet.model.merges ?? []
  assert.ok(merges.includes('P2:P4'), `订单 A 的三行应合并为 P2:P4，实际：${merges.join(',')}`)
  assert.ok(merges.includes('P6:P7'), `订单 C 的两行应合并为 P6:P7，实际：${merges.join(',')}`)
  assert.ok(!sheet.getCell('P5').isMerged, '单行订单 B 不应合并')
  assert.ok(!sheet.getCell('P8').isMerged, '无明细订单 D 不应合并')
  assert.ok(sheet.getCell('P3').isMerged && sheet.getCell('P4').isMerged, '合并区间内单元格应标记为已合并')
  assert.match(String(sheet.getCell('P2').value), /CNY/, '合并后的订单总金额保留首行取值')
  assert.match(String(sheet.getCell('P6').value), /USD/, 'USD 订单总金额同理')
  assert.notEqual(String(sheet.getCell('P5').value), '', '单行订单仍保留订单总金额')
  // 合并只作用于订单总金额列：产品级列、截图列均不合并
  assert.ok(!sheet.getCell('A3').isMerged, '序号列不合并')
  assert.ok(!sheet.getCell('J3').isMerged, '产品名称列不合并')
  assert.ok(!sheet.getCell('V3').isMerged, '截图列不合并')
  // 合并后底部单元格补回分隔线
  assert.ok(sheet.getCell('P4').border?.bottom, '合并区间底部应保留分隔线')
  // 图片仍嵌在订单首行（订单 A 两张、订单 C 一张）
  assert.equal((workbook.model.media ?? []).length, 3, '三张截图应全部嵌入')
  const imageRows = sheet
    .getImages()
    .map((image) => Math.round(image.range.tl.nativeRow) + 1)
    .sort((a, b) => a - b)
  assert.deepEqual(imageRows, [2, 2, 6], '截图锚定在各自订单的首行')

  // --- 3. 差分：HEAD 尚未合并订单总金额 ------------------------------------
  const headResponse = await exportXlsx(head, baseFixture())
  const headSheet = (await readSheet(headResponse)).getWorksheet('每日订单台账')
  const headMerges = headSheet.model.merges ?? []
  assert.ok(!headMerges.includes('P2:P4'), '改动前不应出现订单总金额合并（差分有效）')
  assert.match(String(headSheet.getCell('P2').value), /CNY/, '改动前订单总金额同样逐行填写')

  // --- 4. 1000 张上限 ------------------------------------------------------
  const underLimit = []
  for (let i = 0; i < 100; i += 1) {
    underLimit.push(
      order(`L${i}`, 100, 'CNY', [item(`l${i}`)], Array.from({ length: 10 }, () => attachment())),
    )
  }
  const okResponse = await exportXlsx(current, underLimit)
  assert.equal(okResponse.status, 200, '恰好 1000 张截图应允许导出')

  const overLimit = [...underLimit, order('L100', 100, 'CNY', [item('l100')], [attachment()])]
  const limited = await exportXlsx(current, overLimit)
  assert.equal(limited.status, 413, '超过 1000 张截图应拒绝导出')
  const payload = JSON.parse(Buffer.from(limited.body).toString('utf8'))
  assert.match(payload.error, /1001 张截图/, '错误信息应给出实际张数')
  assert.match(payload.error, /最多导出 1000 张/, '错误信息应给出 1000 张上限')

  console.log('✅ 每日订单导出：订单总金额纵向合并 + 1000 张截图上限 均通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
