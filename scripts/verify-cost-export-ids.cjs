/**
 * 验证订单成本导出的「勾选订单」改造：
 *   1. 不传 ids 时结果与改动前完全一致（差分 HEAD vs 工作区）；
 *   2. 传 ids 时只返回勾选的订单；
 *   3. 数百个 id 时 .in('id', …) 每批不超过 100 个（Kong URI 上限）；
 *   4. 不在筛选/状态范围内的 id 被忽略。
 *
 * 运行：NODE_PATH=<主工作区>/node_modules ELECTRON_RUN_AS_NODE=1 <Qoder> scripts/verify-cost-export-ids.cjs
 */
const assert = require('node:assert')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const esbuild = require('esbuild')

const REPO = path.resolve(__dirname, '..')
const BASE = 'HEAD'
const TARGET = 'src/lib/business-order-costs-server.ts'

function gitShow(spec) {
  return execFileSync('git', ['-C', REPO, 'show', `${BASE}:${spec}`], { encoding: 'utf8' })
}

const aliasPlugin = {
  name: 'alias',
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const base = path.join(REPO, 'src', args.path.slice(2))
      for (const ext of ['.ts', '.tsx', '.js', '/index.ts', '/index.tsx']) {
        const candidate = base + ext
        if (fs.existsSync(candidate)) return { path: candidate }
      }
      return { path: base + '.ts' }
    })
  },
}

async function loadModule(tsSource, resolveDir) {
  const result = await esbuild.build({
    stdin: { contents: tsSource, resolveDir, loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    plugins: [aliasPlugin],
    external: ['next/cache'],
    logLevel: 'silent',
  })
  const mod = { exports: {} }
  const shimRequire = (id) => {
    if (id === 'next/cache') return { unstable_cache: (fn) => fn, revalidateTag: () => {} }
    return require(id)
  }
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(
    mod,
    mod.exports,
    shimRequire,
  )
  return mod.exports
}

// ---------------------------------------------------------------------------
// mock SupabaseClient
// ---------------------------------------------------------------------------

function parseIlikePairs(orStr) {
  const pairs = []
  for (const segment of orStr.split(',')) {
    const idx = segment.indexOf('.ilike.')
    if (idx === -1) continue
    pairs.push([segment.slice(0, idx), segment.slice(idx + '.ilike.'.length)])
  }
  return pairs
}

function ilike(value, pattern) {
  const kw = pattern.replace(/^%/, '').replace(/%$/, '').toLowerCase()
  return String(value ?? '').toLowerCase().includes(kw)
}

class MockQuery {
  constructor(client, table) {
    this.client = client
    this.table = table
    this.predicates = []
    this.orderSpecs = []
    this.rangeFrom = 0
    this.rangeTo = Infinity
  }
  select() { return this }
  eq(col, val) {
    if (col.includes('.')) {
      const [child, sub] = col.split('.')
      this.predicates.push((row) => (row[child] ?? []).some((c) => c[sub] === val))
    } else {
      this.predicates.push((row) => row[col] === val)
    }
    return this
  }
  is(col, val) {
    this.predicates.push((row) => (val === null ? row[col] == null : row[col] !== null))
    return this
  }
  gte(col, val) { this.predicates.push((row) => row[col] != null && !(row[col] < val)); return this }
  lte(col, val) { this.predicates.push((row) => row[col] != null && !(row[col] > val)); return this }
  in(col, vals) {
    if (col === 'id') this.client.idChunks.push(vals.length)
    this.predicates.push((row) => vals.includes(row[col]))
    return this
  }
  or(orStr, opts) {
    const pairs = parseIlikePairs(orStr)
    if (opts && opts.referencedTable) {
      const child = opts.referencedTable
      this.predicates.push((row) =>
        (row[child] ?? []).some((c) => pairs.some(([col, pat]) => ilike(c[col], pat))),
      )
    } else {
      this.predicates.push((row) => pairs.some(([col, pat]) => ilike(row[col], pat)))
    }
    return this
  }
  order(col, opts) { this.orderSpecs.push({ col, ascending: opts?.ascending !== false }); return this }
  range(from, to) { this.rangeFrom = from; this.rangeTo = to; return this }
  limit(n) { this.rangeFrom = 0; this.rangeTo = n - 1; return this }

  run() {
    let rows = [...(this.client.tables[this.table] ?? [])]
    for (const predicate of this.predicates) rows = rows.filter(predicate)
    if (this.orderSpecs.length > 0) {
      const specs = this.orderSpecs
      rows.sort((a, b) => {
        for (const { col, ascending } of specs) {
          if (a[col] === b[col]) continue
          const cmp = a[col] < b[col] ? -1 : 1
          return ascending ? cmp : -cmp
        }
        return 0
      })
    }
    const page = rows.slice(this.rangeFrom, this.rangeTo === Infinity ? undefined : this.rangeTo + 1)
    return { data: page, error: null }
  }

  then(onFulfilled) {
    return Promise.resolve().then(() => onFulfilled(this.run()))
  }
}

function makeClient(tables) {
  return {
    tables,
    idChunks: [],
    from(table) { return new MockQuery(this, table) },
    rpc(name, params) {
      let rows = [...(tables[`rpc:${name}`] ?? [])]
      if (params?.p_order_ids) rows = rows.filter((r) => params.p_order_ids.includes(r.order_id))
      return Promise.resolve({ data: rows, error: null })
    },
  }
}

// ---------------------------------------------------------------------------
// 夹具：250 单，每单 1 个产品行，全部收齐且发完
// ---------------------------------------------------------------------------

const ORDER_COUNT = 250

function makeItem(orderId) {
  const n = orderId.slice(1)
  return {
    id: `i${n}`,
    business_order_id: orderId,
    product_id: `pdt${n}`,
    custom_product_id: null,
    sku_snapshot: `SKU-${n}`,
    name_snapshot: `产品${n}`,
    image_url_snapshot: null,
    quantity: 10,
    unit_price: 10,
    line_amount: 100,
    sales_total_amount: 100,
    product_received_amount: 100,
    logistics_fee_amount: null,
    daily_shipping_category: 'stock',
    sort_order: 1,
    created_at: '2026-10-01T00:00:00Z',
  }
}

function makeOrder(index) {
  const id = `o${String(index).padStart(3, '0')}`
  return {
    id,
    order_number: `BO-${index}`,
    order_date: '2026-10-01',
    created_at: '2026-10-01T00:00:00Z',
    fulfillment_status: 'fully_shipped',
    voided_at: null,
    shop_id: 's1',
    salesperson_id: null,
    shop_group_id: null,
    currency: 'USD',
    total_amount: 100,
    total_sales_amount: null,
    total_product_received_amount: null,
    items_subtotal: 100,
    total_shipping_received_amount: null,
    shipping_fee: 0,
    customer_id: null,
    customer_snapshot: { name: `客户${index}` },
    shop_name_snapshot: '店铺A',
    shop_group_name_snapshot: '组A',
    daily_shipping_date: '2026-10-02',
    daily_shipping_number: `SHIP-${index}`,
    payment_account: null,
    external_order_number: null,
    sales_notes: null,
    salesperson: null,
    customer: null,
    business_order_items: [makeItem(id)],
    business_order_attachments: [
      {
        id: `a${index}`,
        status: 'active',
        object_path: `shots/${index}.jpg`,
        mime_type: 'image/jpeg',
        size_bytes: 1000,
      },
    ],
    business_order_shipments: [
      {
        id: `s${index}`,
        voided_at: null,
        business_order_shipment_items: [{ order_item_id: `i${String(index).padStart(3, '0')}`, quantity: 10 }],
      },
    ],
    business_order_returns: [],
    business_order_payment_allocations: [],
  }
}

function buildTables() {
  const orders = Array.from({ length: ORDER_COUNT }, (_, i) => makeOrder(i + 1))
  return {
    business_orders: orders,
    product_financials: orders.map((order, i) => ({
      product_id: order.business_order_items[0].product_id,
      financial_number: `FN-${i + 1}`,
      product_name: null,
      cost: 4,
    })),
    finance_business_order_item_cost_overrides: [],
    finance_business_order_item_settlements: [],
    business_order_cost_marks: [{ order_id: 'o001' }, { order_id: 'o250' }],
    'rpc:get_business_orders_outstanding_amount': orders.map((order) => ({
      order_id: order.id,
      outstanding_amount: 0,
    })),
  }
}

const FILTERS = {
  q: '',
  dateFrom: '',
  dateTo: '',
  month: '',
  shops: [],
  salespeople: [],
  shopGroups: [],
  shippingCategories: [],
  page: 1,
}

const EXPORT_LIMIT = 2000

function simplify(result) {
  return {
    totalCount: result.totalCount,
    rows: result.rows.map((row) => ({
      order_id: row.order_id,
      item_id: row.item_id,
      item_ids: row.item_ids,
      cost: row.cost,
      quantity: row.quantity,
      total_cost: row.total_cost,
      product_name: row.product_name,
      marked: row.marked,
      attachments: row.attachments.length,
    })),
  }
}

async function main() {
  const oldSource = gitShow(TARGET)
  const newSource = fs.readFileSync(path.join(REPO, TARGET), 'utf8')
  assert.notStrictEqual(oldSource, newSource, '工作区没有改动，差分无意义')

  const libDir = path.join(REPO, 'src', 'lib')
  const oldMod = await loadModule(oldSource, libDir)
  const newMod = await loadModule(newSource, libDir)

  // 1) 不传 ids：与改动前逐字段一致，且未触发任何按 id 的拆分查询。
  const oldClient = makeClient(buildTables())
  const newClient = makeClient(buildTables())
  const oldResult = simplify(
    await oldMod.fetchBusinessOrderProductCosts(oldClient, FILTERS, 1, EXPORT_LIMIT),
  )
  const newResult = simplify(
    await newMod.fetchBusinessOrderProductCosts(newClient, FILTERS, 1, EXPORT_LIMIT),
  )
  assert.deepStrictEqual(newResult, oldResult, '不传 ids 时结果与改动前不一致')
  assert.strictEqual(oldResult.totalCount, ORDER_COUNT, `期望 ${ORDER_COUNT} 单，实际 ${oldResult.totalCount}`)
  assert.deepStrictEqual(newClient.idChunks, [], '不传 ids 时不应出现 .in(id) 查询')
  assert.ok(
    newResult.rows.filter((row) => row.marked).map((row) => row.order_id).sort().join(',') === 'o001,o250',
    '标记订单应为 o001 / o250',
  )

  // 2) 传全部 250 个 id：全部返回，且每批 .in(id) 不超过 100。
  const allIds = buildTables().business_orders.map((order) => order.id)
  const chunkClient = makeClient(buildTables())
  const chunkResult = simplify(
    await newMod.fetchBusinessOrderProductCosts(chunkClient, FILTERS, 1, EXPORT_LIMIT, { ids: allIds }),
  )
  assert.strictEqual(chunkResult.totalCount, ORDER_COUNT, '传全部 id 时应返回全部订单')
  assert.deepStrictEqual(chunkClient.idChunks, [100, 100, 50], `分批应为 100/100/50，实际 ${chunkClient.idChunks}`)
  assert.deepStrictEqual(
    chunkResult.rows.map((row) => row.order_id),
    newResult.rows.map((row) => row.order_id),
    '勾选全部时行顺序应与不筛选一致',
  )

  // 3) 只勾选 120 单：只返回这些单。
  const selected = allIds.filter((id) => Number(id.slice(1)) % 2 === 0).slice(0, 120)
  const selectedClient = makeClient(buildTables())
  const selectedResult = simplify(
    await newMod.fetchBusinessOrderProductCosts(selectedClient, FILTERS, 1, EXPORT_LIMIT, { ids: selected }),
  )
  const selectedSet = new Set(selected)
  assert.strictEqual(selectedResult.totalCount, selected.length, '勾选导出应只包含勾选订单')
  assert.ok(
    selectedResult.rows.every((row) => selectedSet.has(row.order_id)),
    '勾选导出出现未勾选的订单',
  )
  assert.ok(selectedClient.idChunks.every((size) => size <= 100), '仍应按 100 分批')

  // 4) 勾选不在筛选范围内的订单（已作废）不返回。
  const tables = buildTables()
  tables.business_orders[0].voided_at = '2026-10-05T00:00:00Z'
  const voidedClient = makeClient(tables)
  const voidedResult = simplify(
    await newMod.fetchBusinessOrderProductCosts(voidedClient, FILTERS, 1, EXPORT_LIMIT, {
      ids: ['o001', 'o002'],
    }),
  )
  assert.deepStrictEqual(
    voidedResult.rows.map((row) => row.order_id),
    ['o002'],
    '作废订单即便被勾选也不应导出',
  )

  console.log('✔ 成本导出 ids 改造校验通过：')
  console.log(`  · 不传 ids 与改动前一致（${newResult.rows.length} 行 / ${newResult.totalCount} 单）`)
  console.log(`  · 勾选 250 单 → 分 ${chunkClient.idChunks.join('/')} 批查询`)
  console.log(`  · 勾选 120 单 → 只导出 ${selectedResult.totalCount} 单`)
  console.log('  · 勾选已作废订单 → 被忽略')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
