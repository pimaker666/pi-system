import {
  BadgeDollarSign,
  BarChart3,
  Boxes,
  Check,
  CreditCard,
  FilePlus2,
  FileText,
  HandCoins,
  Landmark,
  LayoutDashboard,
  NotebookText,
  Package,
  PackageSearch,
  ReceiptText,
  Scale,
  Settings,
  ShieldCheck,
  Users,
  UsersRound,
  Wallet,
} from 'lucide-react'
import type { UserRole } from '@/types'

export interface NavItem {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  allowedRoles?: UserRole[]
  requiresFinanceView?: boolean
  attentionBadge?: boolean
  match?: (pathname: string) => boolean
}

export const NAV: NavItem[] = [
  { href: '/dashboard', label: '工作台', icon: LayoutDashboard },
  {
    href: '/finance',
    label: '财务总览',
    icon: BarChart3,
    allowedRoles: ['admin', 'finance'],
    requiresFinanceView: true,
  },
  { href: '/pi/create', label: '开具 PI', icon: FilePlus2 },
  {
    href: '/pi/history',
    label: 'PI 历史',
    icon: FileText,
    match: (pathname) => pathname.startsWith('/pi') && pathname !== '/pi/create',
  },
  { href: '/weight-calc', label: '计算重量', icon: Scale },
  { href: '/reimbursement', label: '费用报销', icon: Wallet },
  {
    href: '/finance/daily-orders',
    label: '每日订单',
    icon: FileText,
    allowedRoles: ['sales', 'supervisor', 'admin', 'finance'],
  },
  {
    href: '/finance/costs',
    label: '订单成本',
    icon: CreditCard,
    allowedRoles: ['admin', 'finance'],
    requiresFinanceView: true,
  },
  {
    href: '/finance/settled-orders',
    label: '已结算订单',
    icon: Check,
    allowedRoles: ['admin', 'finance'],
    requiresFinanceView: true,
  },
  {
    href: '/finance/transactions',
    label: '收支流水',
    icon: ReceiptText,
    allowedRoles: ['admin', 'finance'],
    requiresFinanceView: true,
  },
  {
    href: '/finance/journal',
    label: '财务日记账',
    icon: NotebookText,
    allowedRoles: ['admin', 'finance'],
    requiresFinanceView: true,
  },
  { href: '/finance/performance', label: '业务业绩', icon: BarChart3 },
  {
    href: '/finance/profit',
    label: '利润核算',
    icon: Landmark,
    allowedRoles: ['admin', 'finance'],
    requiresFinanceView: true,
  },
  {
    href: '/finance/commission',
    label: '提成计算',
    icon: BadgeDollarSign,
    attentionBadge: true,
  },
  {
    href: '/finance/my-commission',
    label: '我的提成',
    icon: HandCoins,
    allowedRoles: ['sales', 'supervisor'],
  },
  {
    href: '/finance/commission/settled',
    label: '已结清订单',
    icon: Check,
    allowedRoles: ['admin', 'finance'],
    requiresFinanceView: true,
  },
  {
    href: '/products',
    label: '产品库',
    icon: Package,
    match: (pathname) =>
      pathname.startsWith('/products') && !pathname.startsWith('/products/groups'),
  },
  { href: '/products/groups', label: '产品分组', icon: Boxes },
  {
    href: '/finance/custom-products',
    label: '定制产品库',
    icon: PackageSearch,
    allowedRoles: ['sales', 'supervisor', 'admin', 'finance'],
  },
  {
    href: '/customers',
    label: '客户',
    icon: Users,
    match: (pathname) =>
      pathname.startsWith('/customers') && !pathname.startsWith('/customers/groups'),
  },
  { href: '/customers/groups', label: '客户分组', icon: UsersRound },
  { href: '/settings', label: '公司设置', icon: Settings },
  {
    href: '/users',
    label: '账号管理',
    icon: ShieldCheck,
    allowedRoles: ['admin', 'finance'],
    match: (pathname) => pathname === '/users' || /^\/users\/[^/]+\/permissions$/.test(pathname),
  },
  {
    href: '/users/permissions',
    label: '权限管理',
    icon: ShieldCheck,
    allowedRoles: ['admin'],
    match: (pathname) =>
      pathname.startsWith('/users/permissions') ||
      pathname.startsWith('/users/approval-flow') ||
      pathname.startsWith('/users/audit-logs'),
  },
]

export const NAV_GROUPS = [
  { label: null, hrefs: ['/dashboard', '/finance'] },
  { label: 'PI 与工具', hrefs: ['/pi/create', '/pi/history', '/weight-calc'] },
  {
    label: '订单与收款',
    hrefs: ['/finance/daily-orders', '/finance/costs', '/finance/settled-orders'],
  },
  {
    label: '财务账簿',
    hrefs: ['/finance/journal', '/finance/transactions', '/reimbursement'],
  },
  {
    label: '业绩与提成',
    hrefs: [
      '/finance/performance',
      '/finance/profit',
      '/finance/commission',
      '/finance/my-commission',
      '/finance/commission/settled',
    ],
  },
  { label: '产品', hrefs: ['/products', '/products/groups', '/finance/custom-products'] },
  { label: '客户', hrefs: ['/customers', '/customers/groups'] },
  { label: '系统', hrefs: ['/settings', '/users', '/users/permissions'] },
]

export function filterNavItems(role: UserRole, canViewFinance: boolean): NavItem[] {
  return NAV.filter((item) => {
    if (item.requiresFinanceView) return canViewFinance
    return !item.allowedRoles || item.allowedRoles.includes(role)
  })
}
