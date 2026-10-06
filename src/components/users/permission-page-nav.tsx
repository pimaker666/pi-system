import Link from 'next/link'
import { ShieldCheck, Users, Workflow, ScrollText } from 'lucide-react'
import { cn } from '@/lib/utils'

const items = [
  { href: '/users', label: '账号管理', icon: Users },
  { href: '/users/permissions', label: '角色权限', icon: ShieldCheck },
  { href: '/users/approval-flow', label: '审批流', icon: Workflow },
  { href: '/users/audit-logs', label: '审批与审计', icon: ScrollText },
]

export function PermissionPageNav({
  active,
  showConfiguration = true,
}: {
  active: string
  showConfiguration?: boolean
}) {
  const visibleItems = showConfiguration
    ? items
    : items.filter((item) => item.href === '/users' || item.href === '/users/audit-logs')
  return (
    <nav className="flex flex-wrap gap-2 border-b pb-4">
      {visibleItems.map((item) => {
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              active === item.href
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
