// NOTE: This module must NOT be a Client Component. It is rendered exclusively
// on the server via renderToBuffer() in the /api/pi/[id]/pdf route handler.
// Marking it 'use client' turns PiDocument into a client reference, and calling
// it from the server throws "Attempted to call PiDocument() from the server but
// PiDocument is on the client" → HTTP 500. The browser never imports this file
// (preview uses an <iframe> pointing at the PDF route), so a plain server-safe
// module is correct.
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Image,
} from '@react-pdf/renderer'
import { registerPdfFonts } from '@/lib/pdf-fonts'
import { formatCurrency, formatDate } from '@/lib/utils'
import { derivePalette, type PiPalette } from '@/lib/pi-theme'
import { toServerImageSrc } from '@/lib/supabase/image'
import type { CompanySettings, CompanySnapshot, ProformaInvoiceWithItems } from '@/types'

registerPdfFonts()

/** Build the stylesheet from a brand-derived palette so every PI reflects the
 * company's own color while keeping one refined, formal structure. */
function makeStyles(p: PiPalette) {
  return StyleSheet.create({
    page: {
      fontFamily: 'NotoSansSC',
      fontSize: 9,
      color: p.text,
      paddingTop: 40,
      paddingBottom: 60,
      paddingHorizontal: 40,
      lineHeight: 1.45,
    },

    // Full-bleed accent bar across the very top of the page.
    topBar: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 6,
      backgroundColor: p.accent,
    },

    // ---------- Letterhead ----------
    headerBand: { alignItems: 'center', marginBottom: 4 },
    headerLogo: { height: 44, width: 150, objectFit: 'contain', marginBottom: 8 },
    companyName: {
      fontSize: 15,
      fontWeight: 'bold',
      lineHeight: 1.3,
      color: p.accentDark,
      textAlign: 'center',
      marginBottom: 5,
    },
    companyContact: {
      fontFamily: 'Inter',
      fontSize: 8.5,
      fontWeight: 'bold',
      lineHeight: 1.5,
      color: p.text,
      textAlign: 'center',
    },
    companyAddress: {
      fontSize: 8.5,
      fontWeight: 'bold',
      lineHeight: 1.5,
      color: p.text,
      textAlign: 'center',
    },

    accentRule: { height: 2, backgroundColor: p.accent, marginTop: 10, marginBottom: 8 },
    docTitle: {
      fontFamily: 'Inter',
      fontSize: 17,
      fontWeight: 'bold',
      lineHeight: 1.3,
      letterSpacing: 3,
      color: p.accent,
      textAlign: 'center',
      marginBottom: 8,
    },
    thinRule: { height: 1, backgroundColor: p.border, marginBottom: 14 },

    // ---------- Parties (Bill To / Invoice meta) ----------
    partiesRow: { flexDirection: 'row', gap: 12, alignItems: 'stretch' },
    partyCol: { flex: 1 },
    billPanel: {
      flexGrow: 1,
      backgroundColor: p.tint,
      borderLeftWidth: 3,
      borderLeftColor: p.accent,
      borderRadius: 4,
      paddingVertical: 10,
      paddingHorizontal: 12,
    },
    metaPanel: {
      flexGrow: 1,
      backgroundColor: p.tintStrong,
      borderRadius: 4,
      paddingVertical: 10,
      paddingHorizontal: 12,
    },
    sectionLabel: {
      fontSize: 9,
      fontWeight: 'normal',
      color: '#000000',
      marginBottom: 6,
      textTransform: 'uppercase',
      letterSpacing: 1,
    },
    billName: { fontSize: 9, fontWeight: 'normal', lineHeight: 1.5, color: '#000000' },
    billLine: { fontSize: 9, fontWeight: 'normal', lineHeight: 1.5, color: '#000000' },
    latin: {},
    metaLine: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 5,
    },
    metaKey: {
      fontSize: 9,
      fontWeight: 'normal',
      lineHeight: 1.5,
      color: '#000000',
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    metaVal: { fontSize: 9, fontWeight: 'normal', lineHeight: 1.5, color: '#000000' },

    // ---------- Items table ----------
    table: { marginTop: 16 },
    th: {
      flexDirection: 'row',
      backgroundColor: p.accent,
      paddingVertical: 7,
    },
    thText: {
      fontFamily: 'Inter',
      fontSize: 8,
      fontWeight: 'bold',
      color: p.onAccent,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    tr: {
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: 1,
      borderBottomColor: p.border,
      paddingVertical: 7,
      minHeight: 30,
    },
    trAlt: { backgroundColor: p.tint },
    cellPad: { paddingHorizontal: 6 },
    amount: { fontFamily: 'Inter', color: p.text },
    itemName: { fontWeight: 'bold', color: p.text },
    itemSku: { fontFamily: 'Inter', fontSize: 7, color: p.muted, marginTop: 1 },
    itemImage: { width: 38, height: 38, objectFit: 'contain' },
    imgPlaceholder: { fontFamily: 'Inter', fontSize: 7, color: p.muted },
    remarkText: { fontSize: 8, color: p.softText },
    remarkImage: { width: 44, height: 44, objectFit: 'contain', marginTop: 3 },
    specText: { fontSize: 8, lineHeight: 1.3, color: '#000000' },

    // ---------- Summary ----------
    summaryWrap: { flexDirection: 'column', alignItems: 'flex-end', marginTop: 14 },
    summaryBox: { width: 260 },
    summaryRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 3,
      paddingHorizontal: 8,
    },
    summaryKey: { fontFamily: 'Inter', fontSize: 10, fontWeight: 'bold', color: '#000000' },
    summaryVal: { fontFamily: 'Inter', fontSize: 10, fontWeight: 'bold', color: '#000000' },
    // Shipping row spans wider so the transport method sits in its own left column.
    shippingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      width: 500,
      paddingVertical: 3,
    },
    shippingMethod: {
      flex: 1,
      fontSize: 9,
      fontWeight: 'bold',
      lineHeight: 1.3,
      color: '#000000',
      paddingRight: 12,
      textAlign: 'left',
    },
    shippingInner: {
      width: 260,
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 8,
    },
    summaryTotal: {
      width: 260,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 9,
      paddingHorizontal: 10,
      marginTop: 6,
      backgroundColor: p.accentDark,
      borderRadius: 4,
    },
    summaryTotalLabel: {
      fontFamily: 'Inter',
      fontSize: 9,
      fontWeight: 'bold',
      color: p.onAccent,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    summaryTotalVal: { fontFamily: 'Inter', fontSize: 13, fontWeight: 'bold', color: p.onAccent },

    // ---------- Bank remittance ----------
    bankBox: {
      marginTop: 24,
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: 5,
      padding: 14,
      backgroundColor: p.tintStrong,
    },
    bankTitle: {
      fontFamily: 'Inter',
      fontSize: 9,
      fontWeight: 'bold',
      color: p.accent,
      textTransform: 'uppercase',
      letterSpacing: 1,
      marginBottom: 8,
    },
    bankGrid: { flexDirection: 'row', flexWrap: 'wrap' },
    bankField: { width: '50%', marginBottom: 6, paddingRight: 10 },
    bankFieldFull: { width: '100%', marginBottom: 6 },
    bankKey: {
      fontFamily: 'Inter',
      fontSize: 7,
      color: p.muted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 1,
    },
    bankVal: { fontFamily: 'Inter', fontSize: 9.5, fontWeight: 'bold', color: p.text },

    // ---------- Terms / notes ----------
    block: { marginTop: 14 },
    blockLabel: {
      fontFamily: 'Inter',
      fontSize: 8,
      fontWeight: 'bold',
      color: p.accent,
      textTransform: 'uppercase',
      letterSpacing: 1,
      marginBottom: 4,
    },
    blockText: { fontSize: 8.5, fontWeight: 'bold', color: '#000000' },

    // ---------- Footer ----------
    footer: {
      position: 'absolute',
      bottom: 26,
      left: 40,
      right: 40,
      borderTopWidth: 1,
      borderTopColor: p.border,
      paddingTop: 7,
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    footerText: { fontFamily: 'Inter', fontSize: 7, color: p.muted },
    thanks: {
      textAlign: 'center',
      marginTop: 22,
      fontFamily: 'Inter',
      fontSize: 8.5,
      color: p.accent,
      letterSpacing: 0.5,
    },

    voidMark: {
      position: 'absolute',
      top: 280,
      left: 110,
      fontFamily: 'Inter',
      fontSize: 96,
      color: 'rgba(200,0,0,0.12)',
      transform: 'rotate(-24deg)',
      fontWeight: 'bold',
    },
  })
}

interface PiDocumentProps {
  pi: ProformaInvoiceWithItems
  company: CompanySettings | CompanySnapshot | null
}

export function PiDocument({ pi, company }: PiDocumentProps) {
  const pal = derivePalette(company?.accent_color)
  const styles = makeStyles(pal)

  const c = pi.customer_snapshot
  const items = [...pi.pi_items].sort((a, b) => a.sort_order - b.sort_order)
  const companyContact = [
    company?.phone ? `Tel/WhatsApp: ${company.phone}` : null,
    company?.email,
    company?.website,
  ]
    .filter(Boolean)
    .join('   ·   ')
  const companyAddress = company?.address ?? ''
  const showRemark = items.some(
    (i) => (i.description && i.description.trim()) || i.remark_image_url,
  )
  const showSpec = pi.show_specification !== false
  const showWeight = pi.show_weight === true
  const col: {
    idx: string
    name: string
    img: string
    spec: string
    qty: string
    price: string
    total: string
    remark: string
    weight: string
  } = showSpec
    ? showRemark
      ? { idx: '4%', name: '18%', img: '10%', spec: '15%', qty: '9%', price: '14%', total: '14%', remark: '16%', weight: '0%' }
      : { idx: '5%', name: '22%', img: '12%', spec: '18%', qty: '11%', price: '16%', total: '16%', remark: '0%', weight: '0%' }
    : showRemark
      ? { idx: '5%', name: '24%', img: '12%', spec: '0%', qty: '11%', price: '16%', total: '16%', remark: '16%', weight: '0%' }
      : { idx: '6%', name: '30%', img: '14%', spec: '0%', qty: '14%', price: '18%', total: '18%', remark: '0%', weight: '0%' }
  if (showWeight) {
    // Carve out a narrow weight column by borrowing width from the name column,
    // keeping the row total at ~100% without disturbing the default layout.
    col.weight = '9%'
    col.name = `${parseFloat(col.name) - 9}%`
  }
  const hasBank =
    company?.bank_name ||
    company?.bank_account ||
    company?.bank_swift ||
    company?.bank_address

  return (
    <Document title={pi.pi_number}>
      <Page size="A4" style={styles.page}>
        <View style={styles.topBar} fixed />
        {pi.status === 'void' && <Text style={styles.voidMark}>VOID</Text>}

        {/* Letterhead: centered company banner */}
        <View style={styles.headerBand}>
          {company?.logo_url ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image src={toServerImageSrc(company.logo_url)} style={styles.headerLogo} />
          ) : null}
          <Text style={styles.companyName}>
            {company?.company_name ?? 'Your Company Name'}
          </Text>
          {companyContact ? (
            <Text style={styles.companyContact}>{companyContact}</Text>
          ) : null}
          {companyAddress ? (
            <Text style={styles.companyAddress}>{companyAddress}</Text>
          ) : null}
        </View>

        <View style={styles.accentRule} />
        <Text style={styles.docTitle}>PROFORMA INVOICE</Text>
        <View style={styles.thinRule} />

        {/* Parties: Bill To (left) / Invoice details (right) */}
        <View style={styles.partiesRow}>
          <View style={styles.partyCol}>
            <View style={styles.billPanel}>
              <Text style={styles.sectionLabel}>Bill To</Text>
              <Text style={styles.billName}>{c.name}</Text>
              {c.company && <Text style={styles.billLine}>{c.company}</Text>}
              {c.address && <Text style={styles.billLine}>{c.address}</Text>}
              {c.country && <Text style={styles.billLine}>{c.country}</Text>}
              {c.phone && <Text style={[styles.billLine, styles.latin]}>Tel: {c.phone}</Text>}
              {c.email && <Text style={[styles.billLine, styles.latin]}>{c.email}</Text>}
            </View>
          </View>
          <View style={styles.partyCol}>
            <View style={styles.metaPanel}>
              <View style={styles.metaLine}>
                <Text style={styles.metaKey}>PI No.</Text>
                <Text style={styles.metaVal}>{pi.pi_number}</Text>
              </View>
              <View style={styles.metaLine}>
                <Text style={styles.metaKey}>Date</Text>
                <Text style={styles.metaVal}>{formatDate(pi.created_at)}</Text>
              </View>
              <View style={styles.metaLine}>
                <Text style={styles.metaKey}>Currency</Text>
                <Text style={styles.metaVal}>{pi.currency}</Text>
              </View>
              {c.contact_person && (
                <View style={styles.metaLine}>
                  <Text style={styles.metaKey}>Attn</Text>
                  <Text style={styles.metaVal}>{c.contact_person}</Text>
                </View>
              )}
              {pi.status === 'void' && (
                <View style={styles.metaLine}>
                  <Text style={styles.metaKey}>Status</Text>
                  <Text style={[styles.metaVal, { color: '#c00000' }]}>VOID</Text>
                </View>
              )}
            </View>
          </View>
        </View>

        {/* Items table */}
        <View style={styles.table}>
          <View style={styles.th}>
            <Text style={[{ width: col.idx }, styles.cellPad, styles.thText]}>#</Text>
            <Text style={[{ width: col.name }, styles.cellPad, styles.thText]}>Product</Text>
            <Text style={[{ width: col.img }, styles.cellPad, styles.thText]}>Image</Text>
            {showSpec && (
              <Text style={[{ width: col.spec }, styles.cellPad, styles.thText]}>Specification</Text>
            )}
            {showWeight && (
              <Text style={[{ width: col.weight, textAlign: 'right' }, styles.cellPad, styles.thText]}>
                Weight
              </Text>
            )}
            <Text style={[{ width: col.qty, textAlign: 'right' }, styles.cellPad, styles.thText]}>
              Qty
            </Text>
            <View style={[{ width: col.price }, styles.cellPad]}>
              <Text style={[styles.thText, { textAlign: 'right' }]}>Unit Price</Text>
              <Text style={[styles.thText, { textAlign: 'right' }]}>({pi.currency})</Text>
            </View>
            <View style={[{ width: col.total }, styles.cellPad]}>
              <Text style={[styles.thText, { textAlign: 'right' }]}>Amount</Text>
              <Text style={[styles.thText, { textAlign: 'right' }]}>({pi.currency})</Text>
            </View>
            {showRemark && (
              <Text style={[{ width: col.remark }, styles.cellPad, styles.thText]}>Remarks</Text>
            )}
          </View>
          {items.map((item, idx) => (
            <View
              key={item.id}
              style={idx % 2 === 1 ? [styles.tr, styles.trAlt] : styles.tr}
              wrap={false}
            >
              <Text style={[{ width: col.idx }, styles.cellPad, styles.latin]}>{idx + 1}</Text>
              <View style={[{ width: col.name }, styles.cellPad]}>
                <Text style={styles.itemName}>{item.name}</Text>
                <Text style={styles.itemSku}>SKU: {item.sku}</Text>
              </View>
              <View style={[{ width: col.img }, styles.cellPad]}>
                {item.image_url ? (
                  // eslint-disable-next-line jsx-a11y/alt-text
                  <Image src={toServerImageSrc(item.image_url)} style={styles.itemImage} />
                ) : (
                  <Text style={styles.imgPlaceholder}>—</Text>
                )}
              </View>
              {showSpec && (
                <View style={[{ width: col.spec }, styles.cellPad]}>
                  {item.specification ? (
                    <Text style={styles.specText}>{item.specification}</Text>
                  ) : (
                    <Text style={styles.imgPlaceholder}>—</Text>
                  )}
                </View>
              )}
              {showWeight && (
                <Text style={[{ width: col.weight, textAlign: 'right' }, styles.cellPad, styles.latin]}>
                  {item.weight_g != null ? `${item.weight_g} g` : '—'}
                </Text>
              )}
              <Text style={[{ width: col.qty, textAlign: 'right' }, styles.cellPad, styles.latin]}>
                {item.quantity} {item.unit}
              </Text>
              <Text style={[{ width: col.price, textAlign: 'right' }, styles.cellPad, styles.amount]}>
                {formatCurrency(item.unit_price, pi.currency)}
              </Text>
              <Text style={[{ width: col.total, textAlign: 'right' }, styles.cellPad, styles.amount]}>
                {formatCurrency(item.line_total, pi.currency)}
              </Text>
              {showRemark && (
                <View style={[{ width: col.remark }, styles.cellPad]}>
                  {item.description ? (
                    <Text style={styles.remarkText}>{item.description}</Text>
                  ) : null}
                  {item.remark_image_url ? (
                    // eslint-disable-next-line jsx-a11y/alt-text
                    <Image src={toServerImageSrc(item.remark_image_url)} style={styles.remarkImage} />
                  ) : null}
                </View>
              )}
            </View>
          ))}
        </View>

        {/* Summary */}
        <View style={styles.summaryWrap}>
          <View style={styles.summaryBox}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryKey}>Subtotal</Text>
              <Text style={styles.summaryVal}>{formatCurrency(pi.subtotal, pi.currency)}</Text>
            </View>
            {pi.discount > 0 && (
              <View style={styles.summaryRow}>
                <Text style={styles.summaryKey}>Discount</Text>
                <Text style={styles.summaryVal}>-{formatCurrency(pi.discount, pi.currency)}</Text>
              </View>
            )}
            {pi.tax_rate > 0 && (
              <View style={styles.summaryRow}>
                <Text style={styles.summaryKey}>Tax ({pi.tax_rate}%)</Text>
                <Text style={styles.summaryVal}>{formatCurrency(pi.tax_amount, pi.currency)}</Text>
              </View>
            )}
          </View>
          {(pi.shipping_fee > 0 || !!pi.shipping_method) && (
            <View style={styles.shippingRow}>
              <Text style={styles.shippingMethod}>{pi.shipping_method ?? ''}</Text>
              <View style={styles.shippingInner}>
                <Text style={styles.summaryKey}>Shipping Freight</Text>
                <Text style={styles.summaryVal}>{formatCurrency(pi.shipping_fee, pi.currency)}</Text>
              </View>
            </View>
          )}
          <View style={styles.summaryTotal}>
            <Text style={styles.summaryTotalLabel}>Grand Total ({pi.currency})</Text>
            <Text style={styles.summaryTotalVal}>{formatCurrency(pi.total, pi.currency)}</Text>
          </View>
        </View>

        {/* Bank remittance details */}
        {hasBank && (
          <View style={styles.bankBox} wrap={false}>
            <Text style={styles.bankTitle}>Bank Remittance Details</Text>
            <View style={styles.bankGrid}>
              {company?.bank_name && (
                <View style={styles.bankField}>
                  <Text style={styles.bankKey}>Beneficiary Bank</Text>
                  <Text style={styles.bankVal}>{company.bank_name}</Text>
                </View>
              )}
              {company?.bank_account && (
                <View style={styles.bankField}>
                  <Text style={styles.bankKey}>Account No.</Text>
                  <Text style={styles.bankVal}>{company.bank_account}</Text>
                </View>
              )}
              {company?.bank_swift && (
                <View style={styles.bankField}>
                  <Text style={styles.bankKey}>SWIFT / BIC</Text>
                  <Text style={styles.bankVal}>{company.bank_swift}</Text>
                </View>
              )}
              {company?.company_name && (
                <View style={styles.bankField}>
                  <Text style={styles.bankKey}>Beneficiary Name</Text>
                  <Text style={styles.bankVal}>{company.company_name}</Text>
                </View>
              )}
              {company?.bank_address && (
                <View style={styles.bankFieldFull}>
                  <Text style={styles.bankKey}>Bank Address</Text>
                  <Text style={styles.bankVal}>{company.bank_address}</Text>
                </View>
              )}
            </View>
          </View>
        )}

        {/* Terms & notes */}
        {pi.terms && (
          <View style={styles.block}>
            <Text style={styles.blockLabel}>Terms &amp; Conditions</Text>
            <Text style={styles.blockText}>{pi.terms}</Text>
          </View>
        )}
        {pi.notes && (
          <View style={styles.block}>
            <Text style={styles.blockLabel}>Notes</Text>
            <Text style={styles.blockText}>{pi.notes}</Text>
          </View>
        )}

        {!pi.terms && !pi.notes && (
          <Text style={styles.thanks}>Thank you for your business.</Text>
        )}

        {/* Fixed footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {company?.company_name ?? ''} · Proforma Invoice {pi.pi_number}
          </Text>
          <Text style={styles.footerText}>{pi.pi_number}</Text>
        </View>
      </Page>
    </Document>
  )
}
