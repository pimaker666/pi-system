'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
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
  Package,
  PackageSearch,
  ReceiptText,
  Scale,
  Settings,
  ShieldCheck,
  Users,
  UsersRound,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { UserRole } from '@/types'

interface NavItem {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  allowedRoles?: UserRole[]
  requiresFinanceView?: boolean
  attentionBadge?: boolean
  match?: (pathname: string) => boolean
}

const NAV: NavItem[] = [
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

const NAV_GROUPS = [
  { label: null, hrefs: ['/dashboard', '/finance'] },
  { label: 'PI 与工具', hrefs: ['/pi/create', '/pi/history', '/weight-calc'] },
  {
    label: '订单与收款',
    hrefs: [
      '/finance/daily-orders',
      '/finance/costs',
      '/finance/settled-orders',
      '/finance/transactions',
    ],
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

export function Sidebar({
  role,
  fullName,
  canViewFinance = false,
  commissionAttentionCount = 0,
}: {
  role: UserRole
  fullName: string | null
  canViewFinance?: boolean
  commissionAttentionCount?: number
}) {
  const pathname = usePathname()
  const attentionBadge = commissionAttentionCount > 99 ? '99+' : commissionAttentionCount
  const items = NAV.filter((item) => {
    if (item.requiresFinanceView) return canViewFinance
    return !item.allowedRoles || item.allowedRoles.includes(role)
  })
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: items.filter((item) => group.hrefs.includes(item.href)),
  })).filter((group) => group.items.length > 0)
  const activeHref = items.reduce<string>((best, item) => {
    const matches = item.match
      ? item.match(pathname)
      : item.href === '/finance'
        ? pathname === item.href
        : pathname === item.href || pathname.startsWith(`${item.href}/`)
    return matches && item.href.length > best.length ? item.href : best
  }, '')

  return (
    <aside className="flex h-full w-16 shrink-0 flex-col border-r border-white/10 bg-[hsl(var(--sidebar-background))] text-slate-200 md:w-72">
      <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2 py-4 md:px-4 md:py-5" aria-label="主导航">
        {groups.map((group, groupIndex) => (
          <section key={group.label ?? 'overview'} className="space-y-1" aria-label={group.label ?? '工作台'}>
            {group.label && (
              <p className="hidden px-3 pb-1 pt-1 text-sm font-medium tracking-wide text-slate-400 md:block">
                {group.label}
              </p>
            )}
            {group.items.map((item) => {
              const active = item.href === activeHref
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.label}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'group relative flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--sidebar-background))] md:min-h-12 md:flex-row md:justify-start md:gap-4 md:px-3 md:py-2 md:text-base',
                    active
                      ? 'bg-blue-500/20 text-white shadow-[inset_3px_0_0_rgb(96_165_250)]'
                      : 'text-slate-300 hover:bg-white/10 hover:text-white',
                  )}
                >
                  <Icon className="h-5 w-5 shrink-0 text-slate-400 transition-colors group-hover:text-slate-200 md:h-6 md:w-6" aria-hidden="true" />
                  <span className="w-full text-center text-[10px] leading-3 md:w-auto md:flex-1 md:text-left md:text-base md:leading-6">
                    {item.label}
                  </span>
                  {item.attentionBadge && commissionAttentionCount > 0 && (
                    <span className="absolute right-1 top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-5 text-white md:static md:min-w-6 md:text-xs md:leading-6">
                      {attentionBadge}
                    </span>
                  )}
                </Link>
              )
            })}
            {groupIndex === 0 && <div className="hidden md:block" />}
          </section>
        ))}
      </nav>

      <div className="flex shrink-0 items-center justify-center gap-3 border-t border-white/10 p-3 md:justify-start md:px-5 md:py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-blue-100" aria-hidden="true">
          {fullName?.slice(0, 1) || '用'}
        </div>
        <div className="sr-only min-w-0 md:not-sr-only">
          <div className="truncate text-sm font-medium text-white" title={fullName ?? '用户'}>{fullName ?? '用户'}</div>
          <div className="text-xs text-slate-400">
            {role === 'admin'
              ? '管理员'
              : role === 'finance'
                ? '财务'
                : role === 'supervisor'
                  ? '业务主管'
                  : '业务员'}
          </div>
        </div>
      </div>
    </aside>
  )
}
