export const FINANCE_PAGE_KEYS = {
  overview: 'finance.page.overview',
  journal: 'finance.page.journal',
  costs: 'finance.page.costs',
  settledOrders: 'finance.page.settled_orders',
  profit: 'finance.page.profit',
  commissionSettled: 'finance.page.commission_settled',
} as const

export type FinancePage = keyof typeof FINANCE_PAGE_KEYS

export type FinancePageAccess = Record<FinancePage, boolean>

export const FINANCE_PAGE_PERMISSION_LIST = Object.values(FINANCE_PAGE_KEYS)

export const NO_FINANCE_PAGE_ACCESS: FinancePageAccess = {
  overview: false,
  journal: false,
  costs: false,
  settledOrders: false,
  profit: false,
  commissionSettled: false,
}
