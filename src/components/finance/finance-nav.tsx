'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import type { UserRole } from '@/types'

const financeNavGroups = [
  {
    items: [
      { href: '/finance', label: '财务总览', financeOnly: true },
      { href: '/finance/daily-orders', label: '每日订单', financeOnly: false },
    ],
  },
  {
    borderClass: 'bg-red-50',
    items: [
      { href: '/finance/costs', label: '订单成本', financeOnly: true },
      { href: '/finance/settled-orders', label: '已结算订单', financeOnly: true },
    ],
  },
  {
    borderClass: 'bg-sky-50',
    items: [
      { href: '/finance/commission', label: '提成计算', financeOnly: false },
      { href: '/finance/my-commission', label: '我的提成', salesOnly: true },
      { href: '/finance/commission/settled', label: '已结清订单', financeOnly: true },
    ],
  },
  {
    items: [
      { href: '/finance/performance', label: '业务业绩', financeOnly: false },
      { href: '/finance/profit', label: '利润核算', financeOnly: true },
    ],
  },
] as const

export function FinanceNav({
  role,
  commissionAttentionCount,
}: {
  role: UserRole
  commissionAttentionCount: number
}) {
  const pathname = usePathname()
  const canManageFinance = role === 'admin' || role === 'finance'
  const commissionBadge = commissionAttentionCount > 99 ? '99+' : commissionAttentionCount
  const groups = financeNavGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        if ('supervisorOnly' in item && item.supervisorOnly)
          return role === 'supervisor'
        if ('salesOnly' in item && item.salesOnly)
          return role === 'sales' || role === 'supervisor'
        if ('financeOnly' in item && item.financeOnly) return canManageFinance
        return true
      }),
    }))
    .filter((group) => group.items.length > 0)
  const items = groups.flatMap((group) => group.items)

  const activeHref = items.reduce<string>((best, item) => {
    const matches =
      item.href === '/finance'
        ? pathname === item.href
        : pathname === item.href || pathname.startsWith(`${item.href}/`)
    if (matches && item.href.length > best.length) return item.href
    return best
  }, '')

  return (
    <nav
      className="mb-6 flex flex-wrap gap-2 border-b pb-3"
      aria-label="财务模块导航"
    >
      {groups.map((group) => {
        const borderClass = 'borderClass' in group ? group.borderClass : undefined

        return (
          <div
            key={group.items[0].href}
            className={cn(
              'flex items-center gap-1',
              borderClass && 'rounded-md px-1',
              borderClass,
            )}
          >
            {group.items.map((item) => {
              const active = item.href === activeHref
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'relative rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  {item.label}
                  {!canManageFinance && item.href === '/finance/commission' && commissionAttentionCount > 0 && (
                    <span className="absolute -right-2 -top-2 inline-flex min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-xs font-semibold leading-5 text-destructive-foreground">
                      {commissionBadge}
                    </span>
                  )}
                </Link>
              )
            })}
          </div>
        )
      })}
    </nav>
  )
}
