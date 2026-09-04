'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import type { UserRole } from '@/types'

const financeItems = [
  { href: '/finance', label: '财务总览', financeOnly: true },
  { href: '/finance/daily-orders', label: '每日订单', financeOnly: true },
  { href: '/finance/transactions', label: '收支流水', financeOnly: true },
  { href: '/finance/costs', label: '订单成本', financeOnly: true },
  { href: '/finance/performance', label: '业务业绩', financeOnly: false },
]

export function FinanceNav({ role }: { role: UserRole }) {
  const pathname = usePathname()
  const canManageFinance = role === 'admin' || role === 'finance'
  const items = financeItems.filter((item) => !item.financeOnly || canManageFinance)

  return (
    <nav className="mb-6 flex flex-wrap gap-2 border-b pb-3" aria-label="财务模块导航">
      {items.map((item) => {
        const active =
          item.href === '/finance' ? pathname === item.href : pathname.startsWith(item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'rounded-md px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
