import type {
  FinanceOrder,
  FinanceOrderCost,
  FinanceTransaction,
} from '@/types'

export const FINANCE_COST_LABELS = {
  product: '采购成本',
  shipping: '物流费用',
  customs: '关税/清关',
  platform_fee: '平台费用',
  payment_fee: '收款手续费',
  other: '其他成本',
} as const

export const FINANCE_TRANSACTION_LABELS = {
  income: '收入',
  expense: '支出',
} as const

export function formatCny(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
  }).format(value)
}

export function sumActiveCny<T extends { amount_cny: number; status?: string }>(rows: T[]) {
  return rows.reduce(
    (sum, row) => sum + (row.status === 'void' ? 0 : Number(row.amount_cny)),
    0,
  )
}

export function getFinanceSummary(
  orders: FinanceOrder[],
  transactions: FinanceTransaction[],
  costs: FinanceOrderCost[],
) {
  const activeOrders = orders.filter((row) => row.status === 'active')
  const activeTransactions = transactions.filter((row) => row.status === 'active')
  const orderRevenue = sumActiveCny(activeOrders)
  const income = activeTransactions
    .filter((row) => row.transaction_type === 'income')
    .reduce((sum, row) => sum + Number(row.amount_cny), 0)
  const expense = activeTransactions
    .filter((row) => row.transaction_type === 'expense')
    .reduce((sum, row) => sum + Number(row.amount_cny), 0)
  const orderCosts = costs.reduce((sum, row) => sum + Number(row.amount_cny), 0)

  return {
    orderRevenue,
    income,
    expense,
    orderCosts,
    grossProfit: orderRevenue - orderCosts,
    cashBalance: income - expense,
  }
}
