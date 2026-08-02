'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Package,
  Boxes,
  Users,
  UsersRound,
  FileText,
  FilePlus2,
  Scale,
  Settings,
  ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { UserRole } from '@/types'

interface NavItem {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  adminOnly?: boolean
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
    match: (p) => p.startsWith('/products') && !p.startsWith('/products/groups'),
  },
  { href: '/products/groups', label: '产品分组', icon: Boxes },
  {
    href: '/customers',
    label: '客户',
    icon: Users,
    match: (p) => p.startsWith('/customers') && !p.startsWith('/customers/groups'),
  },
  { href: '/customers/groups', label: '客户分组', icon: UsersRound },
  { href: '/settings', label: '公司设置', icon: Settings },
  { href: '/users', label: '用户管理', icon: ShieldCheck, adminOnly: true },
]

export function Sidebar({ role, fullName }: { role: UserRole; fullName: string | null }) {
  const pathname = usePathname()
  const items = NAV.filter((item) => !item.adminOnly || role === 'admin')

  return (
    <aside className="flex h-full w-60 flex-col border-r bg-muted/30">
      <div className="flex h-16 items-center gap-2 border-b px-6">
        <FileText className="h-6 w-6 text-primary" />
        <span className="text-lg font-semibold">PI 系统</span>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {items.map((item) => {
          const active = item.match ? item.match(pathname) : pathname === item.href
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="border-t p-4">
        <div className="text-sm font-medium">{fullName ?? '用户'}</div>
        <div className="text-xs text-muted-foreground">
          {role === 'admin' ? '管理员' : '业务员'}
        </div>
      </div>
    </aside>
  )
}
