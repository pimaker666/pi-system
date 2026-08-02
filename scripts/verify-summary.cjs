/* Standalone harness to visually verify the PI summary layout (transport
 * method left column + Shipping Freight / Grand Total labels). Replicates the
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
  onAccent: '#ffffff',
  accentDark: '#0f766e',
  tint: '#f0fdfa',
}

const s = StyleSheet.create({
  page: { fontFamily: 'NotoSansSC', fontSize: 9, padding: 40, color: p.text },
  summaryWrap: { flexDirection: 'column', alignItems: 'flex-end', marginTop: 14 },
  summaryBox: { width: 260 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, paddingHorizontal: 8 },
  summaryKey: { fontFamily: 'Inter', fontSize: 9, color: p.softText },
  summaryVal: { fontFamily: 'Inter', fontSize: 9, color: p.text },
  shippingRow: { flexDirection: 'row', alignItems: 'center', width: 500, paddingVertical: 3 },
  shippingMethod: { flex: 1, fontSize: 8, lineHeight: 1.3, color: p.softText, paddingRight: 12, textAlign: 'left' },
  shippingInner: { width: 260, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 8 },
  summaryTotal: { width: 260, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 10, marginTop: 6, backgroundColor: p.accentDark, borderRadius: 4 },
  summaryTotalLabel: { fontFamily: 'Inter', fontSize: 9, fontWeight: 'bold', color: p.onAccent, textTransform: 'uppercase', letterSpacing: 0.8 },
  summaryTotalVal: { fontFamily: 'Inter', fontSize: 13, fontWeight: 'bold', color: p.onAccent },
})

const h = React.createElement
function Summary({ shippingMethod }) {
  return h(View, { style: s.summaryWrap }, [
    h(View, { style: s.summaryBox, key: 'box' }, [
      h(View, { style: s.summaryRow, key: 'sub' }, [
        h(Text, { style: s.summaryKey, key: 'k' }, 'Subtotal'),
        h(Text, { style: s.summaryVal, key: 'v' }, '$12,300.00'),
      ]),
      h(View, { style: s.summaryRow, key: 'tax' }, [
        h(Text, { style: s.summaryKey, key: 'k' }, 'Tax (5%)'),
        h(Text, { style: s.summaryVal, key: 'v' }, '$615.00'),
      ]),
    ]),
    h(View, { style: s.shippingRow, key: 'ship' }, [
      h(Text, { style: s.shippingMethod, key: 'm' }, shippingMethod),
      h(View, { style: s.shippingInner, key: 'in' }, [
        h(Text, { style: s.summaryKey, key: 'k' }, 'Shipping Freight'),
        h(Text, { style: s.summaryVal, key: 'v' }, '$450.00'),
      ]),
    ]),
    h(View, { style: s.summaryTotal, key: 'total' }, [
      h(Text, { style: s.summaryTotalLabel, key: 'l' }, 'Grand Total (USD)'),
      h(Text, { style: s.summaryTotalVal, key: 'v' }, '$13,365.00'),
    ]),
  ])
}

const doc = h(Document, null,
  h(Page, { size: 'A4', style: s.page }, [
    h(Text, { key: 't', style: { fontFamily: 'Inter', fontSize: 14, marginBottom: 10 } }, 'Summary layout check'),
    h(Summary, { key: 'a', shippingMethod: 'Transportation Within China, 7 Days' }),
    h(View, { key: 'sp', style: { height: 24 } }),
    h(Summary, { key: 'b', shippingMethod: 'Sea Transportation, 22~40 Days (FOB Shanghai)' }),
  ]),
)

renderToFile(doc, path.join(process.cwd(), 'scripts', 'verify-summary.pdf')).then(() => {
  console.log('OK: scripts/verify-summary.pdf')
})
