/* eslint-disable jsx-a11y/alt-text -- react-pdf Image does not expose the DOM alt prop */
import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import { registerPdfFonts } from '@/lib/pdf-fonts'
import { DAILY_ORDER_COLUMNS, formatDailyMoney, PAYMENT_LABELS, SHIPPING_LABELS } from '@/lib/daily-orders'
import { displayProfileName } from '@/lib/utils'
import type { DailyOrder } from '@/types'

registerPdfFonts()

export interface DailyOrderPdfRow extends DailyOrder {
  imageSources: Array<string | null>
}

const widths = [3, 5, 6, 6, 7, 5, 7, 5, 8, 4, 7, 7, 6, 7, 5, 8, 4]
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
      {orders.map((order, rowIndex) => {
        const values = [
          String(rowIndex + 1), order.order_date, order.shop_name_snapshot, displayProfileName(
            order.salesperson,
            order.salesperson_display_name_snapshot || order.salesperson_name_snapshot,
          ),
          order.order_number, order.shipping_date, order.shipping_number || '', SHIPPING_LABELS[order.shipping_category],
          `${order.product_name_snapshot}\n${order.product_sku_snapshot}`, String(Number(order.quantity)),
          formatDailyMoney(order.sales_unit_price_amount, order.sales_unit_price_currency),
          formatDailyMoney(order.product_received_amount, order.product_received_currency),
          formatDailyMoney(order.logistics_fee_amount, order.logistics_fee_currency),
          formatDailyMoney(order.sales_total_amount, order.sales_total_currency), PAYMENT_LABELS[order.payment_category], order.remarks || '',
        ]
        return <View key={order.id} style={styles.row} wrap={false}>
          {values.map((value, index) => <Cell key={index} index={index}><Text>{value}</Text></Cell>)}
          <Cell index={16}><View style={styles.images}>{order.imageSources.map((source, index) => source ? <Image key={index} src={source} style={styles.image} /> : <Text key={index} style={styles.unavailable}>图片不可用</Text>)}</View></Cell>
        </View>
      })}
    </View>
  </Page></Document>
}
