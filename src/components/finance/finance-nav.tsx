'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { FinancePageAccess } from '@/lib/finance-permissions'
import { cn } from '@/lib/utils'
import type { UserRole } from '@/types'

/**
 * 财务 tab 都是重查询页。prefetch 默认整页预取会在进入视口时同时渲染所有 tab，
 * 反而拖慢当前页；这里改成悬停/聚焦后才升级为整页预取，点到时数据多半已就绪。
 */
function PrefetchOnIntentLink({
  href,
  className,
  children,
}: {
  href: string
  className: string
  children: React.ReactNode
}) {
  const [intent, setIntent] = React.useState(false)
  const arm = () => setIntent(true)
  return (
    <Link
      href={href}
      prefetch={intent}
      className={className}
      onPointerEnter={arm}
      onFocus={arm}
    >
      {children}
    </Link>
  )
}

const financeNavGroups = [
  {
    items: [
      { href: '/finance', label: '财务总览', financePage: 'overview' },
      { href: '/finance/journal', label: '日记账', financePage: 'journal' },
      { href: '/finance/journal/overview', label: '收支总览', financePage: 'journal' },
      { href: '/finance/daily-orders', label: '每日订单' },
    ],
  },
  {
    borderClass: 'bg-red-50',
    items: [
      { href: '/finance/costs', label: '订单成本', financePage: 'costs' },
      { href: '/finance/settled-orders', label: '已结算订单', financePage: 'settledOrders' },
    ],
  },
  {
    borderClass: 'bg-sky-50',
    items: [
      { href: '/finance/commission', label: '提成计算' },
      { href: '/finance/my-commission', label: '我的提成', salesOnly: true },
      { href: '/finance/commission/settled', label: '已结清订单', financePage: 'commissionSettled' },
    ],
  },
  {
    items: [
      { href: '/finance/performance', label: '业务业绩' },
      { href: '/finance/profit', label: '利润核算', financePage: 'profit' },
    ],
  },
] as const

export function FinanceNav({
  role,
  commissionAttentionCount,
  financeAccess,
}: {
  role: UserRole
  commissionAttentionCount: number
  /** 财务页面 tab 可见性：按账号的页面级权限逐项放行。 */
  financeAccess: FinancePageAccess
}) {
  const pathname = usePathname()
  const commissionBadge = commissionAttentionCount > 99 ? '99+' : commissionAttentionCount
  const showCommissionBadge = role === 'sales' || role === 'supervisor'
  const groups = financeNavGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        if ('supervisorOnly' in item && item.supervisorOnly)
          return role === 'supervisor'
        if ('salesOnly' in item && item.salesOnly)
          return role === 'sales' || role === 'supervisor'
        if ('financePage' in item && item.financePage) return financeAccess[item.financePage]
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
      className="mb-6 flex flex-wrap gap-2 rounded-xl border bg-card p-2 shadow-sm"
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
                <PrefetchOnIntentLink
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
                  {showCommissionBadge && item.href === '/finance/commission' && commissionAttentionCount > 0 && (
                    <span className="absolute -right-2 -top-2 inline-flex min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-xs font-semibold leading-5 text-destructive-foreground">
                      {commissionBadge}
                    </span>
                  )}
                </PrefetchOnIntentLink>
              )
            })}
          </div>
        )
      })}
    </nav>
  )
}
