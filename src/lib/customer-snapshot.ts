/**
 * 订单快照里的客户展示名与标签色。
 * 三个订单视图（结算/成本/提成）此前各写一份，口径改一次要改三处，统一放这里。
 */
export function customerNameFromSnapshot(customerSnapshot: unknown): string | null {
  if (!customerSnapshot || typeof customerSnapshot !== 'object') return null
  const snapshot = customerSnapshot as { name?: string | null; company?: string | null }
  return snapshot.company || snapshot.name || null
}

export function customerTagColorFromOrder(order: {
  customer?: { tag_color?: string | null } | null
  customer_snapshot?: unknown
}): string | null {
  const liveColor = order.customer?.tag_color
  if (liveColor) return liveColor
  if (!order.customer_snapshot || typeof order.customer_snapshot !== 'object') return null
  return (order.customer_snapshot as { tag_color?: string | null }).tag_color ?? null
}
