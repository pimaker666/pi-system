'use client'

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
import type { CompanySettings, ProformaInvoiceWithItems } from '@/types'

registerPdfFonts()

// Brand accent used for the title, table header rule and section labels.
const ACCENT = '#1e3a5f'
const MUTED = '#6b7280'
const HAIRLINE = '#e2e5ea'

const styles = StyleSheet.create({
  page: {
    fontFamily: 'NotoSansSC',
    fontSize: 9,
    color: '#1a1a1a',
    paddingTop: 36,
    paddingBottom: 56,
    paddingHorizontal: 36,
    lineHeight: 1.4,
  },

  // ---------- Header ----------
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 18,
  },
  brandCol: { maxWidth: 280, flexDirection: 'row', gap: 10 },
  logo: { width: 96, height: 96, objectFit: 'contain' },
  logoPlaceholder: {
    width: 96,
    height: 96,
    borderWidth: 1,
    borderColor: HAIRLINE,
    borderStyle: 'dashed',
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fafbfc',
  },
  logoPlaceholderText: {
    fontFamily: 'Inter',
    fontSize: 7,
    color: '#b6bcc6',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  companyName: { fontSize: 14, fontWeight: 'bold', marginBottom: 3 },
  companyMeta: { fontSize: 8, color: MUTED },

  titleCol: { alignItems: 'flex-end' },
  title: {
    fontFamily: 'Inter',
    fontSize: 22,
    fontWeight: 'bold',
    letterSpacing: 1,
    color: ACCENT,
  },
  metaTable: { marginTop: 8 },
  metaRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 2 },
  metaKey: {
    fontFamily: 'Inter',
    fontSize: 8,
    color: MUTED,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginRight: 6,
  },
  metaVal: { fontFamily: 'Inter', fontSize: 9, fontWeight: 'bold', minWidth: 90, textAlign: 'right' },

  // ---------- Parties ----------
  section: { marginBottom: 12 },
  twoCol: { flexDirection: 'row', justifyContent: 'space-between', gap: 24 },
  col: { flex: 1 },
  sectionLabel: {
    fontFamily: 'Inter',
    fontSize: 8,
    fontWeight: 'bold',
    color: ACCENT,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  bold: { fontWeight: 'bold' },
  latin: { fontFamily: 'Inter' },

  // ---------- Items table ----------
  table: { marginTop: 6 },
  th: {
    flexDirection: 'row',
    backgroundColor: ACCENT,
    paddingVertical: 6,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
  },
  thText: {
    fontFamily: 'Inter',
    fontSize: 8,
    fontWeight: 'bold',
    color: '#ffffff',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tr: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: HAIRLINE, paddingVertical: 6 },
  trAlt: { backgroundColor: '#fafbfc' },
  cIdx: { width: '6%' },
  cName: { width: '40%' },
  cQty: { width: '14%', textAlign: 'right' },
  cPrice: { width: '20%', textAlign: 'right' },
  cTotal: { width: '20%', textAlign: 'right' },
  cellPad: { paddingHorizontal: 5 },
  amount: { fontFamily: 'Inter' },

  // ---------- Summary ----------
  summaryWrap: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
  summaryBox: { width: 250 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  summaryKey: { fontFamily: 'Inter', color: MUTED },
  summaryVal: { fontFamily: 'Inter' },
  summaryTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginTop: 6,
    backgroundColor: ACCENT,
    borderRadius: 3,
  },
  summaryTotalText: { fontFamily: 'Inter', fontSize: 11, fontWeight: 'bold', color: '#ffffff' },

  // ---------- Bank remittance ----------
  bankBox: {
    marginTop: 22,
    borderWidth: 1,
    borderColor: HAIRLINE,
    borderRadius: 4,
    padding: 12,
    backgroundColor: '#fafbfc',
  },
  bankTitle: {
    fontFamily: 'Inter',
    fontSize: 9,
    fontWeight: 'bold',
    color: ACCENT,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  bankGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  bankField: { width: '50%', marginBottom: 5, paddingRight: 8 },
  bankFieldFull: { width: '100%', marginBottom: 5 },
  bankKey: { fontFamily: 'Inter', fontSize: 7, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.5 },
  bankVal: { fontFamily: 'Inter', fontSize: 9, fontWeight: 'bold' },

  // ---------- Terms / notes ----------
  block: { marginTop: 12 },
  blockLabel: {
    fontFamily: 'Inter',
    fontSize: 8,
    fontWeight: 'bold',
    color: ACCENT,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 3,
  },
  blockText: { fontSize: 8, color: '#374151' },

  // ---------- Footer ----------
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 36,
    right: 36,
    borderTopWidth: 1,
    borderTopColor: HAIRLINE,
    paddingTop: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerText: { fontFamily: 'Inter', fontSize: 7, color: '#9aa1ac' },

  voidMark: {
    position: 'absolute',
    top: 260,
    left: 120,
    fontFamily: 'Inter',
    fontSize: 90,
    color: 'rgba(220,0,0,0.15)',
    transform: 'rotate(-25deg)',
    fontWeight: 'bold',
  },
})

interface PiDocumentProps {
  pi: ProformaInvoiceWithItems
  company: CompanySettings | null
}

export function PiDocument({ pi, company }: PiDocumentProps) {
  const c = pi.customer_snapshot
  const items = [...pi.pi_items].sort((a, b) => a.sort_order - b.sort_order)
  const hasBank =
    company?.bank_name ||
    company?.bank_account ||
    company?.bank_swift ||
    company?.bank_address

  return (
    <Document title={pi.pi_number}>
      <Page size="A4" style={styles.page}>
        {pi.status === 'void' && <Text style={styles.voidMark}>VOID</Text>}

        {/* Header: logo + company info (left) / title + meta (right) */}
        <View style={styles.headerRow}>
          <View style={styles.brandCol}>
            {company?.logo_url ? (
              // eslint-disable-next-line jsx-a11y/alt-text
              <Image src={company.logo_url} style={styles.logo} />
            ) : (
              <View style={styles.logoPlaceholder}>
                <Text style={styles.logoPlaceholderText}>LOGO</Text>
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.companyName}>{company?.company_name ?? 'Your Company Name'}</Text>
              {company?.address && <Text style={styles.companyMeta}>{company.address}</Text>}
              {company?.phone && <Text style={styles.companyMeta}>Tel: {company.phone}</Text>}
              {company?.email && <Text style={styles.companyMeta}>{company.email}</Text>}
              {company?.website && <Text style={styles.companyMeta}>{company.website}</Text>}
            </View>
          </View>

          <View style={styles.titleCol}>
            <Text style={styles.title}>PROFORMA INVOICE</Text>
            <View style={styles.metaTable}>
              <View style={styles.metaRow}>
                <Text style={styles.metaKey}>Invoice No.</Text>
                <Text style={styles.metaVal}>{pi.pi_number}</Text>
              </View>
              <View style={styles.metaRow}>
                <Text style={styles.metaKey}>Date</Text>
                <Text style={styles.metaVal}>{formatDate(pi.created_at)}</Text>
              </View>
              <View style={styles.metaRow}>
                <Text style={styles.metaKey}>Currency</Text>
                <Text style={styles.metaVal}>{pi.currency}</Text>
              </View>
            </View>
          </View>
        </View>

        {/* Bill To */}
        <View style={[styles.section, styles.twoCol]}>
          <View style={styles.col}>
            <Text style={styles.sectionLabel}>Bill To</Text>
            <Text style={styles.bold}>{c.name}</Text>
            {c.company && <Text>{c.company}</Text>}
            {c.contact_person && <Text>Attn: {c.contact_person}</Text>}
            {c.address && <Text>{c.address}</Text>}
            {c.country && <Text>{c.country}</Text>}
            {c.phone && <Text style={styles.latin}>Tel: {c.phone}</Text>}
            {c.email && <Text style={styles.latin}>{c.email}</Text>}
          </View>
          <View style={styles.col} />
        </View>

        {/* Items table */}
        <View style={styles.table}>
          <View style={styles.th}>
            <Text style={[styles.cIdx, styles.cellPad, styles.thText]}>#</Text>
            <Text style={[styles.cName, styles.cellPad, styles.thText]}>Description</Text>
            <Text style={[styles.cQty, styles.cellPad, styles.thText]}>Qty</Text>
            <Text style={[styles.cPrice, styles.cellPad, styles.thText]}>Unit Price</Text>
            <Text style={[styles.cTotal, styles.cellPad, styles.thText]}>Amount</Text>
          </View>
          {items.map((item, idx) => (
            <View
              key={item.id}
              style={idx % 2 === 1 ? [styles.tr, styles.trAlt] : styles.tr}
              wrap={false}
            >
              <Text style={[styles.cIdx, styles.cellPad, styles.latin]}>{idx + 1}</Text>
              <View style={[styles.cName, styles.cellPad]}>
                <Text style={styles.bold}>{item.name}</Text>
                <Text style={{ fontFamily: 'Inter', fontSize: 7, color: MUTED }}>
                  SKU: {item.sku}
                </Text>
                {item.description && (
                  <Text style={{ fontSize: 7, color: MUTED }}>{item.description}</Text>
                )}
              </View>
              <Text style={[styles.cQty, styles.cellPad, styles.latin]}>
                {item.quantity} {item.unit}
              </Text>
              <Text style={[styles.cPrice, styles.cellPad, styles.amount]}>
                {formatCurrency(item.unit_price, pi.currency)}
              </Text>
              <Text style={[styles.cTotal, styles.cellPad, styles.amount]}>
                {formatCurrency(item.line_total, pi.currency)}
              </Text>
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
            {pi.shipping_fee > 0 && (
              <View style={styles.summaryRow}>
                <Text style={styles.summaryKey}>Shipping</Text>
                <Text style={styles.summaryVal}>{formatCurrency(pi.shipping_fee, pi.currency)}</Text>
              </View>
            )}
            <View style={styles.summaryTotal}>
              <Text style={styles.summaryTotalText}>TOTAL ({pi.currency})</Text>
              <Text style={styles.summaryTotalText}>{formatCurrency(pi.total, pi.currency)}</Text>
            </View>
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

        {/* Fixed footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {company?.company_name ?? ''} · Proforma Invoice {pi.pi_number}
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  )
}
