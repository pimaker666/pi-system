/**
 * 差分验证 11fa9c5（提成/已结算性能批）不改变任何页面数字。
 *
 * 做法：从 df43bf7（改动前）取出旧版 fetcher，与当前新版各自用同一套
 * 内存夹具 + mock SupabaseClient 跑，deepStrictEqual 对比输出：
 *   - 业务提成 / 我的提成 / 已结清：fetchBusinessOrderCommissions（pending/settled/关键字/月筛选）
 *   - 已结算订单：fetchSettledPeriods+fetchSettledOrderRows（旧） vs fetchSettledOrders（新）
 *
 * 运行：NODE_PATH=<主工作区>/node_modules ELECTRON_RUN_AS_NODE=1 <Qoder> scripts/verify-perf-11fa9c5.cjs
 */
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const esbuild = require('esbuild')

const REPO = path.resolve(__dirname, '..')
const BASE = 'df43bf7'

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
        if (require('node:fs').existsSync(candidate)) return { path: candidate }
      }
      return { path: base + '.ts' }
    })
  },
}

async function loadModule(tsSource) {
  const result = await esbuild.build({
    stdin: { contents: tsSource, resolveDir: path.join(REPO, 'src', 'lib'), loader: 'ts' },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    plugins: [aliasPlugin],
    logLevel: 'silent',
  })
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(mod, mod.exports, require)
  return mod.exports
}

// ---------------------------------------------------------------------------
// mock SupabaseClient：支持这两个 fetcher 用到的全部链式方法
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
    this.expectSingle = null // 'single' | 'maybeSingle' | null
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
  not(col, op, val) {
    if (op === 'is' && val === null) this.predicates.push((row) => row[col] != null)
    return this
  }
  gte(col, val) {
    this.predicates.push((row) => row[col] != null && !(row[col] < val))
    return this
  }
  lte(col, val) {
    this.predicates.push((row) => row[col] != null && !(row[col] > val))
    return this
  }
  in(col, vals) {
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
  order(col, opts) {
    this.orderSpecs.push({ col, ascending: opts?.ascending !== false })
    return this
  }
  range(from, to) {
    this.rangeFrom = from
    this.rangeTo = to
    return this
  }
  limit(n) {
    this.rangeFrom = 0
    this.rangeTo = n - 1
    return this
  }
  single() { this.expectSingle = 'single'; return this }
  maybeSingle() { this.expectSingle = 'maybeSingle'; return this }

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
    if (this.expectSingle === 'single') {
      return page.length > 0
        ? { data: page[0], error: null }
        : { data: null, error: new Error('mock single: no row') }
    }
    if (this.expectSingle === 'maybeSingle') return { data: page[0] ?? null, error: null }
    return { data: page, error: null }
  }

  then(onFulfilled) {
    return Promise.resolve().then(() => onFulfilled(this.run()))
  }
}

function makeClient(tables) {
  return {
    tables,
    from(table) { return new MockQuery(this, table) },
    rpc(name, params) {
      let rows = [...(tables[`rpc:${name}`] ?? [])]
      if (params?.p_customer_ids) rows = rows.filter((r) => params.p_customer_ids.includes(r.customer_id))
      if (params?.p_order_ids) rows = rows.filter((r) => params.p_order_ids.includes(r.order_id))
      return Promise.resolve({ data: rows, error: null })
    },
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const P1 = { id: 'p1', chinese_name: '张三', full_name: null, email: 'zs@x.com' }
const P2 = { id: 'p2', chinese_name: null, full_name: 'Lisa', email: 'lisa@x.com' }

function makeOrder(overrides) {
  return {
    external_order_number: null,
    daily_shipping_number: null,
    payment_account: null,
    shop_name_snapshot: null,
    shop_group_name_snapshot: null,
    salesperson_name_snapshot: null,
    salesperson_display_name_snapshot: null,
    total_shipping_received_amount: null,
    shipping_fee: 0,
    voided_at: null,
    salesperson: null,
    customer: null,
    business_order_shipments: [],
    business_order_returns: [],
    business_order_payment_allocations: [],
    ...overrides,
  }
}

function makeItem(overrides) {
  return {
    product_id: null,
    custom_product_id: null,
    image_url_snapshot: null,
    logistics_fee_amount: null,
    sales_total_amount: null,
    product_received_amount: null,
    ...overrides,
  }
}

function commissionTables() {
  return {
    profiles: [P1, P2],
    customers: [
      { id: 'c1', tag_color: 'red' },
      { id: 'c2', tag_color: null },
    ],
    business_orders: [
      makeOrder({
        id: 'o1', order_number: 'BO-1', order_date: '2026-10-05', created_at: '2026-10-05T08:00:00Z',
        currency: 'CNY', total_amount: 500, total_shipping_received_amount: 20, shipping_fee: 18,
        salesperson_id: 'p1', customer_id: 'c1',
        customer_snapshot: { name: '客户甲', company: '公司甲', tag_color: 'red' },
        shop_name_snapshot: '店A', shop_group_name_snapshot: '组A', external_order_number: 'EXT-1',
        salesperson: P1, customer: { tag_color: 'red' },
        business_order_items: [
          makeItem({
            id: 'i1', product_id: 'pdt1', name_snapshot: '产品甲', sku_snapshot: 'SKU-1',
            quantity: 10, unit_price: 20, line_amount: 200, product_received_amount: 200,
            logistics_fee_amount: 10, daily_shipping_category: 'stock', sort_order: 1,
          }),
          makeItem({
            id: 'i2', custom_product_id: 'cp1', name_snapshot: '定制乙', sku_snapshot: 'CS-1',
            quantity: 2, unit_price: 50, line_amount: 100, product_received_amount: 100,
            daily_shipping_category: 'custom', sort_order: 2,
          }),
        ],
        business_order_shipments: [
          { id: 'sh1', voided_at: null, business_order_shipment_items: [{ order_item_id: 'i1', quantity: 10 }, { order_item_id: 'i2', quantity: 2 }] },
        ],
        business_order_returns: [
          { id: 'r1', voided_at: null, business_order_return_items: [{ order_item_id: 'i1', quantity: 0 }] },
        ],
        business_order_payment_allocations: [
          { order_item_id: 'i1', allocation_target: 'item', amount: 50, voided_at: null, transfer: { voided_at: null } },
          { order_item_id: null, allocation_target: 'shipping', amount: 5, voided_at: null, transfer: { voided_at: null } },
          { order_item_id: 'i1', allocation_target: 'item', amount: 999, voided_at: '2026-10-06T00:00:00Z', transfer: { voided_at: null } },
        ],
      }),
      makeOrder({
        id: 'o2', order_number: 'BO-2', order_date: '2026-10-02', created_at: '2026-10-02T07:00:00Z',
        currency: 'USD', total_amount: 300, shipping_fee: 30,
        salesperson_id: 'p2', customer_id: 'c2',
        customer_snapshot: { name: '客户乙', company: null, tag_color: null },
        shop_name_snapshot: '店B', daily_shipping_number: 'DS-2',
        salesperson: P2, customer: { tag_color: null },
        salesperson_name_snapshot: 'SnapshotName',
        business_order_items: [
          makeItem({
            id: 'i3', product_id: 'pdt2', name_snapshot: 'Product C', sku_snapshot: 'SKU-2',
            quantity: 5, unit_price: 40, line_amount: 200, product_received_amount: 200,
            logistics_fee_amount: 20, daily_shipping_category: 'purchase', sort_order: 1,
            image_url_snapshot: 'img.png',
          }),
        ],
        business_order_shipments: [
          { id: 'sh2', voided_at: null, business_order_shipment_items: [{ order_item_id: 'i3', quantity: 5 }] },
        ],
      }),
      makeOrder({
        id: 'o3', order_number: 'BO-3', order_date: '2026-09-15', created_at: '2026-09-15T07:00:00Z',
        currency: 'CNY', total_amount: 100, total_shipping_received_amount: 10, shipping_fee: 10,
        salesperson_id: 'p1', customer_id: 'c1',
        customer_snapshot: { name: '客户甲', company: '公司甲', tag_color: 'red' },
        salesperson: P1, customer: { tag_color: 'red' },
        business_order_items: [
          makeItem({
            id: 'i4', product_id: 'pdt1', name_snapshot: '产品甲', sku_snapshot: 'SKU-1',
            quantity: 1, unit_price: 100, line_amount: 100, product_received_amount: 100,
            daily_shipping_category: 'stock', sort_order: 1,
          }),
        ],
        business_order_shipments: [
          { id: 'sh3', voided_at: null, business_order_shipment_items: [{ order_item_id: 'i4', quantity: 1 }] },
        ],
      }),
      makeOrder({
        id: 'o4', order_number: 'BO-4', order_date: '2026-10-01', created_at: '2026-10-01T07:00:00Z',
        currency: 'CNY', total_amount: 1, salesperson_id: 'p1', customer_id: null,
        customer_snapshot: null, voided_at: '2026-10-02T00:00:00Z', salesperson: P1,
        business_order_items: [
          makeItem({
            id: 'i5', product_id: 'pdt1', name_snapshot: '作废产品', sku_snapshot: 'SKU-9',
            quantity: 1, unit_price: 1, line_amount: 1, product_received_amount: 1,
            daily_shipping_category: 'stock', sort_order: 1,
          }),
        ],
      }),
    ],
    finance_business_order_item_commissions: [
      { business_order_item_id: 'i1', commission_rate: 7 },
      { business_order_item_id: 'ghost-item', commission_rate: 99 },
    ],
    finance_business_order_commissions: [
      { business_order_id: 'o1', freight_cost: 10, freight_commission_rate: 20, settlement_exchange_rate_to_cny: 7.2 },
      { business_order_id: 'o3', freight_cost: 5, freight_commission_rate: null, settlement_exchange_rate_to_cny: null },
      { business_order_id: 'o4', freight_cost: 1, freight_commission_rate: 1, settlement_exchange_rate_to_cny: null },
    ],
    finance_business_order_item_commission_clearances: [
      { business_order_item_id: 'i3', status: 'confirmed', period: '2026-10-01' },
      { business_order_item_id: 'i1', status: 'pending', period: '2026-10-01' },
      { business_order_item_id: 'i4', status: 'confirmed', period: '2026-09-01' },
      { business_order_item_id: 'ghost-item', status: 'confirmed', period: '2026-08-01' },
    ],
    finance_commission_category_rates: [
      { category: 'stock', product_commission_rate: 3 },
      { category: 'custom', product_commission_rate: 5 },
      { category: 'purchase', product_commission_rate: 2 },
    ],
    finance_customer_commission_tags: [
      { tag_color: 'RED', label: '大客户', product_commission_rate: 8, sort_order: 1 },
    ],
    finance_customer_custom_order_commission_rates: [
      { maximum_custom_order_count: 10, product_commission_rate: 6 },
    ],
    finance_freight_commission_settings: [{ id: 1, freight_commission_rate: 10 }],
    product_financials: [
      { product_id: 'pdt1', financial_number: 'FIN-001', product_name: '财务名甲' },
      { product_id: 'ghost-pdt', financial_number: 'X', product_name: 'Y' },
    ],
    'rpc:get_customer_order_stats': [
      { customer_id: 'c1', custom_order_count: 3 },
      { customer_id: 'c2', custom_order_count: 0 },
    ],
    'rpc:get_business_order_customer_tag_colors': [
      { order_id: 'o1', tag_color: 'red' },
      { order_id: 'o3', tag_color: 'red' },
    ],
  }
}

function settlementTables() {
  const baseItem = (overrides) => ({
    daily_shipping_category: 'stock',
    order: {
      external_order_number: null,
      shop_group_name_snapshot: null,
      salesperson_name_snapshot: null,
      salesperson_display_name_snapshot: null,
      voided_at: null,
      salesperson: P1,
      ...overrides.order,
    },
    ...overrides,
  })
  return {
    profiles: [P1],
    finance_business_order_item_settlements: [
      {
        business_order_item_id: 'si1', period: '2026-09-01', unit_cost: 5, quantity: 10,
        settled_at: '2026-09-30T10:00:00Z', settled_by: 'p1',
        settled_by_profile: P1,
        item: baseItem({
          id: 'si1', name_snapshot: ' settled产品A', sku_snapshot: 'S-1',
          order: {
            id: 'so1', order_number: 'SO-1', external_order_number: 'E-1', order_date: '2026-09-01',
            currency: 'CNY', shop_name_snapshot: '店A', customer_snapshot: { company: '公司甲' },
          },
        }),
      },
      {
        business_order_item_id: 'si2', period: '2026-10-01', unit_cost: null, quantity: 2,
        settled_at: '2026-10-05T09:00:00Z', settled_by: 'p1',
        settled_by_profile: P1,
        item: baseItem({
          id: 'si2', name_snapshot: '产品B', sku_snapshot: 'S-2', daily_shipping_category: 'custom',
          order: {
            id: 'so2', order_number: 'SO-2', order_date: '2026-10-01',
            currency: 'USD', shop_name_snapshot: '店B', shop_group_name_snapshot: '组B',
            customer_snapshot: { name: '客户乙' }, salesperson_name_snapshot: 'SnapshotName',
          },
        }),
      },
      {
        business_order_item_id: 'si3', period: '2026-08-01', unit_cost: 1, quantity: 1,
        settled_at: '2026-08-15T09:00:00Z', settled_by: 'p1',
        settled_by_profile: P1,
        item: baseItem({
          id: 'si3', name_snapshot: '产品C', sku_snapshot: 'S-3',
          order: {
            id: 'so3', order_number: 'SO-3', order_date: '2026-08-01',
            currency: 'CNY', voided_at: '2026-09-01T00:00:00Z', customer_snapshot: null,
          },
        }),
      },
    ],
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const [oldComm, newComm] = await Promise.all([
    loadModule(gitShow('src/lib/business-order-commissions-server.ts')),
    loadModule(require('node:fs').readFileSync(path.join(REPO, 'src/lib/business-order-commissions-server.ts'), 'utf8')),
  ])
  const [oldSettled, newSettled] = await Promise.all([
    loadModule(gitShow('src/lib/business-order-settlements-server.ts')),
    loadModule(require('node:fs').readFileSync(path.join(REPO, 'src/lib/business-order-settlements-server.ts'), 'utf8')),
  ])

  const baseFilters = { q: '', dateFrom: '2026-09-01', dateTo: '2026-10-31', month: '', shops: [], salespeople: [], shopGroups: [], page: 1 }
  const commissionCases = [
    ['pending 第1页', baseFilters, 1, 50, 'pending', false],
    ['settled 含allRows', baseFilters, 1, 50, 'settled', true],
    ['我的提成口径', { ...baseFilters, salespeople: ['p1'], page: 1 }, 1, 1000, 'settled', false],
    ['关键字-表头命中', { ...baseFilters, q: 'BO-2' }, 1, 50, 'pending', false],
    ['关键字-产品命中', { ...baseFilters, q: 'SKU-1' }, 1, 50, 'pending', false],
    ['月筛选', { ...baseFilters, month: '2026-10', dateFrom: '', dateTo: '' }, 1, 50, 'pending', false],
    ['无结果关键字', { ...baseFilters, q: '不存在的东西' }, 1, 50, 'pending', false],
  ]
  for (const [label, filters, page, pageSize, scope, includeAll] of commissionCases) {
    const client = makeClient(commissionTables())
    const a = await oldComm.fetchBusinessOrderCommissions(client, filters, page, pageSize, scope, includeAll)
    const b = await newComm.fetchBusinessOrderCommissions(client, filters, page, pageSize, scope, includeAll)
    assert.deepStrictEqual(b, a)
    console.log(`commissions[${label}] PASS (${a.rows.length} rows, total=${a.totalCount})`)
  }

  const settledCases = [
    ['无筛选', { period: null, q: '' }],
    ['按期间', { period: '2026-09', q: '' }],
    ['按关键字', { period: null, q: 'so-2' }],
    ['关键字无结果', { period: null, q: '不存在' }],
    ['作废单期间', { period: '2026-08', q: '' }],
  ]
  for (const [label, filters] of settledCases) {
    const client = makeClient(settlementTables())
    const periods = await oldSettled.fetchSettledPeriods(client)
    const rows = await oldSettled.fetchSettledOrderRows(client, filters)
    const combined = await newSettled.fetchSettledOrders(client, filters)
    assert.deepStrictEqual(combined.periods, periods)
    assert.deepStrictEqual(combined.rows, rows)
    console.log(`settled[${label}] PASS (${rows.length} rows, periods=${periods.join('/') || '∅'})`)
  }

  console.log('11fa9c5 差分验证 PASS：旧版与新版输出完全一致')
}

main().catch((err) => {
  console.error('11fa9c5 差分验证 FAIL:', err.message)
  process.exit(1)
})
