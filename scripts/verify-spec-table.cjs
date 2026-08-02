/* Standalone harness to visually verify the PI items table with the new
 * Specification column (inserted after Image, before Qty). Replicates the
 * relevant styles/structure from src/components/pi/pi-document.tsx. */
const path = require('path')
const React = require('react')
const {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Font,
  renderToFile,
} = require('@react-pdf/renderer')

const F = (f) => path.join(process.cwd(), 'public', 'fonts', f)
Font.register({
  family: 'NotoSansSC',
  fonts: [
    { src: F('NotoSansSC-Regular.ttf'), fontWeight: 'normal' },
    { src: F('NotoSansSC-Bold.ttf'), fontWeight: 'bold' },
  ],
})
Font.register({
  family: 'Inter',
  fonts: [
    { src: F('Inter-Regular.ttf'), fontWeight: 'normal' },
    { src: F('Inter-Bold.ttf'), fontWeight: 'bold' },
  ],
})
Font.registerHyphenationCallback((w) => [w])

const p = {
  text: '#1f2937',
  softText: '#4b5563',
  muted: '#9ca3af',
  onAccent: '#ffffff',
  accent: '#14b8a6',
  accentDark: '#0f766e',
  tint: '#f0fdfa',
  border: '#e5e7eb',
}

const s = StyleSheet.create({
  page: { fontFamily: 'NotoSansSC', fontSize: 9, padding: 40, color: p.text },
  table: { marginTop: 8, borderWidth: 1, borderColor: p.border, borderRadius: 4 },
  th: { flexDirection: 'row', backgroundColor: p.accent },
  tr: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: p.border, alignItems: 'flex-start' },
  trAlt: { backgroundColor: p.tint },
  cellPad: { paddingVertical: 5, paddingHorizontal: 5 },
  thText: { fontFamily: 'Inter', fontSize: 8, fontWeight: 'bold', color: p.onAccent },
  itemName: { fontSize: 8.5, color: p.text },
  itemSku: { fontFamily: 'Inter', fontSize: 7, color: p.muted, marginTop: 1 },
  imgPlaceholder: { fontFamily: 'Inter', fontSize: 7, color: p.muted },
  latin: { fontFamily: 'Inter', fontSize: 8 },
  amount: { fontFamily: 'Inter', fontSize: 8 },
  specText: { fontSize: 8, lineHeight: 1.3, color: p.softText },
  remarkText: { fontSize: 8, color: p.softText },
})

const h = React.createElement

const ITEMS = [
  { name: 'CALLA Hydrating Facial Serum', sku: 'CL-SR-001', spec: '50ml / 24pcs per box', qty: '100 pcs', price: '$12.50', total: '$1,250.00', remark: 'Gift box packaging' },
  { name: '京颜生物 修复面膜', sku: 'JY-MK-014', spec: '25ml x 10片 / 盒，箱规 48 盒', qty: '200 box', price: '$8.90', total: '$1,780.00', remark: '' },
  { name: 'CALLA Vitamin C Brightening Cream', sku: 'CL-CR-207', spec: '', qty: '60 jar', price: '$15.00', total: '$900.00', remark: 'MOQ 60' },
]

function Table({ showSpec, showRemark, title }) {
  const col = showSpec
    ? showRemark
      ? { idx: '4%', name: '18%', img: '10%', spec: '15%', qty: '9%', price: '14%', total: '14%', remark: '16%' }
      : { idx: '5%', name: '22%', img: '12%', spec: '18%', qty: '11%', price: '16%', total: '16%', remark: '0%' }
    : showRemark
      ? { idx: '5%', name: '24%', img: '12%', spec: '0%', qty: '11%', price: '16%', total: '16%', remark: '16%' }
      : { idx: '6%', name: '30%', img: '14%', spec: '0%', qty: '14%', price: '18%', total: '18%', remark: '0%' }

  const header = h(View, { style: s.th, key: 'h' }, [
    h(Text, { key: 'a', style: [{ width: col.idx }, s.cellPad, s.thText] }, '#'),
    h(Text, { key: 'b', style: [{ width: col.name }, s.cellPad, s.thText] }, 'Product'),
    h(Text, { key: 'c', style: [{ width: col.img }, s.cellPad, s.thText] }, 'Image'),
    showSpec && h(Text, { key: 'd', style: [{ width: col.spec }, s.cellPad, s.thText] }, 'Specification'),
    h(Text, { key: 'e', style: [{ width: col.qty, textAlign: 'right' }, s.cellPad, s.thText] }, 'Qty'),
    h(Text, { key: 'f', style: [{ width: col.price, textAlign: 'right' }, s.cellPad, s.thText] }, 'Unit Price (USD)'),
    h(Text, { key: 'g', style: [{ width: col.total, textAlign: 'right' }, s.cellPad, s.thText] }, 'Amount (USD)'),
    showRemark && h(Text, { key: 'i', style: [{ width: col.remark }, s.cellPad, s.thText] }, 'Remarks'),
  ])

  const rows = ITEMS.map((it, idx) =>
    h(View, { key: idx, style: idx % 2 === 1 ? [s.tr, s.trAlt] : s.tr }, [
      h(Text, { key: 'a', style: [{ width: col.idx }, s.cellPad, s.latin] }, String(idx + 1)),
      h(View, { key: 'b', style: [{ width: col.name }, s.cellPad] }, [
        h(Text, { key: 'n', style: s.itemName }, it.name),
        h(Text, { key: 's', style: s.itemSku }, 'SKU: ' + it.sku),
      ]),
      h(View, { key: 'c', style: [{ width: col.img }, s.cellPad] }, h(Text, { style: s.imgPlaceholder }, '—')),
      showSpec && h(View, { key: 'd', style: [{ width: col.spec }, s.cellPad] },
        it.spec ? h(Text, { style: s.specText }, it.spec) : h(Text, { style: s.imgPlaceholder }, '—')),
      h(Text, { key: 'e', style: [{ width: col.qty, textAlign: 'right' }, s.cellPad, s.latin] }, it.qty),
      h(Text, { key: 'f', style: [{ width: col.price, textAlign: 'right' }, s.cellPad, s.amount] }, it.price),
      h(Text, { key: 'g', style: [{ width: col.total, textAlign: 'right' }, s.cellPad, s.amount] }, it.total),
      showRemark && h(View, { key: 'i', style: [{ width: col.remark }, s.cellPad] },
        it.remark ? h(Text, { style: s.remarkText }, it.remark) : null),
    ]),
  )

  return h(View, { style: { marginBottom: 18 } }, [
    h(Text, { key: 't', style: { fontFamily: 'Inter', fontSize: 11, marginBottom: 4 } }, title),
    h(View, { style: s.table, key: 'tbl' }, [header, ...rows]),
  ])
}

const doc = h(Document, null,
  h(Page, { size: 'A4', style: s.page }, [
    h(Table, { key: '1', showSpec: true, showRemark: true, title: 'showSpec + showRemark' }),
    h(Table, { key: '2', showSpec: true, showRemark: false, title: 'showSpec, no remark' }),
    h(Table, { key: '3', showSpec: false, showRemark: true, title: 'no spec, showRemark' }),
  ]),
)

renderToFile(doc, path.join(process.cwd(), 'scripts', 'verify-spec-table.pdf')).then(() => {
  console.log('OK: scripts/verify-spec-table.pdf')
})
