/* eslint-disable jsx-a11y/alt-text -- react-pdf Image does not expose the DOM alt prop */
import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import type { BusinessDailyExportRow } from '@/lib/business-daily-orders'
import { DAILY_ORDER_COLUMNS } from '@/lib/daily-orders'
import { registerPdfFonts } from '@/lib/pdf-fonts'

registerPdfFonts()

/**
 * PDF 台账行：与 XLSX 共用 buildBusinessDailyExportRows 的输出，
 * 只把截图替换成已下载的 data URL（下载失败时为 null）。
 */
export interface DailyOrderPdfRow extends BusinessDailyExportRow {
  imageSources: Array<string | null>
}

const widths = [2.5, 4.5, 5, 5, 5.5, 4, 5.5, 4, 7.5, 3.5, 5, 5, 5.5, 4.5, 6, 6, 4.5, 6, 3, 4, 3.5]
const styles = StyleSheet.create({
  page: { fontFamily: 'NotoSansSC', padding: 12, fontSize: 5, color: '#111827' },
  title: { fontSize: 13, fontWeight: 'bold', marginBottom: 8 },
  table: { borderTopWidth: 0.5, borderLeftWidth: 0.5, borderColor: '#9CA3AF' },
  row: { flexDirection: 'row', minHeight: 22 },
  header: { backgroundColor: '#E5E7EB', fontWeight: 'bold' },
  cell: { padding: 2, borderRightWidth: 0.5, borderBottomWidth: 0.5, borderColor: '#9CA3AF', justifyContent: 'center' },
  images: { flexDirection: 'row', flexWrap: 'wrap', gap: 1 },
  image: { width: 24, height: 24, objectFit: 'contain' },
  unavailable: { color: '#B91C1C' },
})

function Cell({ index, children }: { index: number; children: React.ReactNode }) {
  return <View style={[styles.cell, { width: `${widths[index]}%` }]}>{children}</View>
}

export function DailyOrdersPdf({ orders }: { orders: DailyOrderPdfRow[] }) {
  return <Document><Page size="A3" orientation="landscape" style={styles.page}>
    <Text style={styles.title}>财务每日订单台账</Text>
    <View style={styles.table}>
      <View style={[styles.row, styles.header]} fixed>{DAILY_ORDER_COLUMNS.map((label, index) => <Cell key={label} index={index}><Text>{label}</Text></Cell>)}</View>
      {orders.map((row, rowIndex) => {
        const values = [
          row.sequence, row.orderDate, row.shop, row.salesperson,
          row.orderNumber, row.shippingDate, row.shippingNumber, row.shippingCategory,
          row.productSku ? `${row.productName}\n${row.productSku}` : row.productName, row.quantity,
          row.shippingProgress, row.unitPrice, row.productReceived, row.logisticsFee,
          row.orderTotal, row.outstandingAmount, row.paymentCategory, row.remarks,
          row.settlementStatus, row.commissionClearanceStatus,
        ]
        return <View key={`${row.orderId}-${rowIndex}`} style={styles.row} wrap={false}>
          {values.map((value, index) => <Cell key={index} index={index}><Text>{value}</Text></Cell>)}
          <Cell index={20}><View style={styles.images}>{row.imageSources.map((source, index) => source ? <Image key={index} src={source} style={styles.image} /> : <Text key={index} style={styles.unavailable}>图片不可用</Text>)}</View></Cell>
        </View>
      })}
    </View>
  </Page></Document>
}
