'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Package,
  PackageSearch,
  Boxes,
  Users,
  UsersRound,
  FileText,
  FilePlus2,
  Scale,
  Landmark,
  Settings,
  ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { UserRole } from '@/types'

interface NavItem {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  allowedRoles?: UserRole[]
  match?: (pathname: string) => boolean
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: '概览', icon: LayoutDashboard },
  { href: '/pi/create', label: '开具 PI', icon: FilePlus2 },
  {
    href: '/pi/history',
    label: 'PI 历史',
    icon: FileText,
    match: (p) => p.startsWith('/pi') && p !== '/pi/create',
  },
  { href: '/weight-calc', label: '计算重量', icon: Scale },
  {
    href: '/products',
    label: '产品库',
    icon: Package,
    match: (p) =>
      p.startsWith('/products') && !p.startsWith('/products/groups'),
  },
  { href: '/products/groups', label: '产品分组', icon: Boxes },
  {
    href: '/finance/custom-products',
    label: '定制产品库',
    icon: PackageSearch,
    allowedRoles: ['sales', 'supervisor', 'admin', 'finance'],
    match: (p) => p.startsWith('/finance/custom-products'),
  },
  {
    href: '/finance/daily-orders',
    label: '每日订单',
    icon: FileText,
    allowedRoles: ['sales', 'supervisor', 'admin', 'finance'],
    match: (p) => p.startsWith('/finance/daily-orders'),
  },
  {
    href: '/customers',
    label: '客户',
    icon: Users,
    match: (p) =>
      p.startsWith('/customers') && !p.startsWith('/customers/groups'),
  },
  { href: '/customers/groups', label: '客户分组', icon: UsersRound },
  {
    href: '/finance',
    label: '财务管理',
    icon: Landmark,
    allowedRoles: ['admin', 'finance'],
    match: (p) =>
      p.startsWith('/finance') &&
      !p.startsWith('/finance/custom-products') &&
      !p.startsWith('/finance/daily-orders'),
  },
  {
    href: '/finance/performance',
    label: '我的业绩',
    icon: Landmark,
    allowedRoles: ['sales', 'supervisor'],
    match: (p) => p.startsWith('/finance/performance'),
  },
  { href: '/settings', label: '公司设置', icon: Settings },
  {
    href: '/users',
    label: '账号管理',
    icon: ShieldCheck,
    allowedRoles: ['admin', 'finance'],
    match: (p) => p === '/users' || /^\/users\/[^/]+\/permissions$/.test(p),
  },
  {
    href: '/users/permissions',
    label: '权限管理',
    icon: ShieldCheck,
    allowedRoles: ['admin'],
    match: (p) => p.startsWith('/users/permissions') || p.startsWith('/users/approval-flow') || p.startsWith('/users/audit-logs'),
  },
]

const NAV_GROUPS = [
  { label: '工作台', hrefs: ['/dashboard'] },
  { label: 'PI 与工具', hrefs: ['/pi/create', '/pi/history', '/weight-calc'] },
  { label: '产品', hrefs: ['/products', '/products/groups', '/finance/custom-products'] },
  { label: '订单与财务', hrefs: ['/finance/daily-orders', '/finance', '/finance/performance'] },
  { label: '客户', hrefs: ['/customers', '/customers/groups'] },
  { label: '系统', hrefs: ['/settings', '/users', '/users/permissions'] },
]

export function Sidebar({
  role,
  fullName,
  canViewFinance = false,
}: {
  role: UserRole
  fullName: string | null
  canViewFinance?: boolean
}) {
  const pathname = usePathname()
  const items = NAV.filter(
    (item) =>
      !item.allowedRoles ||
      item.allowedRoles.includes(role) ||
      (item.href === '/finance' && canViewFinance),
  )
  const groups = NAV_GROUPS
    .map((group) => ({
      ...group,
      items: items.filter((item) => group.hrefs.includes(item.href)),
    }))
    .filter((group) => group.items.length > 0)

  return (
    <aside className="flex h-full w-16 shrink-0 flex-col border-r border-white/10 bg-[hsl(var(--sidebar-background))] text-slate-200 md:w-60">
      <div className="flex h-16 shrink-0 items-center justify-center gap-3 border-b border-white/10 px-2 md:justify-start md:px-5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/20 text-blue-200">
          <FileText className="h-5 w-5" aria-hidden="true" />
        </div>
        <span className="sr-only text-lg font-semibold tracking-tight text-white md:not-sr-only">PI 系统</span>
      </div>

      <nav className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2 md:p-3" aria-label="主导航">
        {groups.map((group) => (
          <section key={group.label} className="space-y-1" aria-label={group.label}>
            <p className="hidden px-3 pb-1 text-xs font-medium tracking-wide text-slate-400 md:block">{group.label}</p>
            {group.items.map((item) => {
              const active = item.match
                ? item.match(pathname)
                : pathname === item.href
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.label}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-12 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--sidebar-background))] md:min-h-10 md:flex-row md:justify-start md:gap-3 md:px-3',
                    active
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-slate-300 hover:bg-white/10 hover:text-white',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="w-full text-center text-[10px] leading-3 md:w-auto md:text-left md:text-sm md:leading-5">{item.label}</span>
                </Link>
              )
            })}
          </section>
        ))}
      </nav>

      <div className="flex shrink-0 items-center justify-center gap-3 border-t border-white/10 p-3 md:justify-start md:p-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-blue-100" aria-hidden="true">{fullName?.slice(0, 1) || '用'}</div>
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
