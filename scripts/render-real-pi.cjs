/**
 * Render the REAL PiDocument component (src/components/pi/pi-document.tsx)
 * server-side with realistic mock data to reproduce the runtime crash.
 * Transpiles TS/TSX on the fly via @next/swc and maps the '@/' alias to src/.
 */
const path = require('path')
const fs = require('fs')
const Module = require('module')
const swc = require('@next/swc-darwin-arm64')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src')

// --- on-the-fly TS/TSX transpile hook ---
const exts = ['.ts', '.tsx', '.jsx']
for (const ext of exts) {
  require.extensions[ext] = function (mod, filename) {
    const code = fs.readFileSync(filename, 'utf8')
    const opts = JSON.stringify({
      filename,
      jsc: {
        parser: { syntax: 'typescript', tsx: filename.endsWith('.tsx') },
        transform: { react: { runtime: 'automatic' } },
        target: 'es2020',
      },
      module: { type: 'commonjs' },
      isModule: true,
    })
    const res = swc.transformSync(code, false, Buffer.from(opts))
    const out = (res && res.code) || res
    mod._compile(out, filename)
  }
}

// --- '@/' alias resolution ---
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    request = path.join(SRC, request.slice(2))
  }
  return origResolve.call(this, request, parent, isMain, options)
}

const React = require('react')
const { renderToBuffer } = require('@react-pdf/renderer')
const { PiDocument } = require(path.join(SRC, 'components/pi/pi-document.tsx'))

const mockPi = {
  id: '11111111-1111-1111-1111-111111111111',
  pi_number: 'PI-2026-001',
  status: 'active',
  currency: 'USD',
  created_at: '2026-07-15T00:00:00Z',
  subtotal: 123.5,
  discount: 0,
  tax_rate: 0,
  tax_amount: 0,
  shipping_fee: 20,
  shipping_method: 'By sea, FOB Shenzhen',
  total: 143.5,
  terms: 'Payment within 30 days.',
  notes: null,
  show_specification: true,
  company_snapshot: null,
  customer_snapshot: {
    name: '测试客户 Test Customer',
    company: 'ACME Trading Co.',
    contact_person: 'John Doe',
    address: '123 Main St',
    country: 'USA',
    email: 'john@example.com',
    phone: '+1 555 0100',
  },
  pi_items: [
    {
      id: 'a1', sort_order: 0, name: '面膜 Facial Mask', sku: 'SKU-001',
      image_url: null, specification: '34g*4pcs/box', quantity: 10, unit: 'box',
      unit_price: 5.5, line_total: 55, description: null, remark_image_url: null,
    },
    {
      id: 'a2', sort_order: 1, name: '精华液 Serum', sku: 'SKU-002',
      image_url: null, specification: null, quantity: 5, unit: 'pcs',
      unit_price: 13.7, line_total: 68.5, description: 'Fragile', remark_image_url: null,
    },
  ],
}

const company = {
  company_name: 'JY Biotech Co., Ltd.',
  accent_color: '#1F3A5F',
  phone: '+86 138 0000 0000',
  email: 'sales@jy.com',
  website: 'www.jy.com',
  address: 'Guangzhou, China',
  logo_url: null,
  bank_name: 'Bank of China',
  bank_account: '1234567890',
  bank_swift: 'BKCHCNBJ',
  bank_address: 'Guangzhou Branch',
}

;(async () => {
  try {
    const buf = await renderToBuffer(React.createElement(PiDocument, { pi: mockPi, company }))
    const outPath = path.join(ROOT, 'scripts', 'real-pi.pdf')
    fs.writeFileSync(outPath, buf)
    console.log('OK: rendered real PiDocument ->', outPath, buf.length, 'bytes')
  } catch (e) {
    console.error('CRASH reproduced:')
    console.error(e && e.stack ? e.stack : e)
    process.exit(1)
  }
})()
