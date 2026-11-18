'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { filterNavItems, NAV_GROUPS } from '@/components/layout/nav-config'
import { NO_FINANCE_PAGE_ACCESS, type FinancePageAccess } from '@/lib/finance-permissions'
import { cn } from '@/lib/utils'
import type { UserRole } from '@/types'
import { ROLE_LABELS } from './sidebar'

/** Mobile-only hamburger + slide-in nav drawer (md+ uses the sidebar). */
export function MobileNav({
  role,
  fullName,
  financeAccess = NO_FINANCE_PAGE_ACCESS,
  commissionAttentionCount = 0,
  approvalPendingCount = 0,
}: {
  role: UserRole
  fullName: string | null
  financeAccess?: FinancePageAccess
  commissionAttentionCount?: number
  approvalPendingCount?: number
}) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  useEffect(() => {
    setOpen(false)
  }, [pathname])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  const items = filterNavItems(role, financeAccess)
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
    <div className="print-chrome md:hidden">
      <Button
        variant="ghost"
        size="sm"
        className="h-9 w-9 shrink-0 p-0"
        onClick={() => setOpen(true)}
        aria-label="打开导航"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </Button>
      {open && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-white/10 bg-[hsl(var(--sidebar-background))] text-slate-200 shadow-xl">
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-4">
              <span className="text-lg font-semibold text-white">PI 系统</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-slate-300 hover:bg-white/10 hover:text-white"
                onClick={() => setOpen(false)}
                aria-label="关闭导航"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="主导航">
              {groups.map((group) => (
                <section key={group.label ?? 'overview'} className="space-y-1" aria-label={group.label ?? '工作台'}>
                  {group.label && (
                    <p className="px-2 pb-1 text-xs font-medium tracking-wide text-slate-400">{group.label}</p>
                  )}
                  {group.items.map((item) => {
                    const active = item.href === activeHref
                    const Icon = item.icon
                    const badgeCount =
                      item.attentionBadge === 'approval'
                        ? approvalPendingCount
                        : item.attentionBadge === 'commission' &&
                            (!item.attentionBadgeRoles || item.attentionBadgeRoles.includes(role))
                          ? commissionAttentionCount
                          : 0
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'group relative flex min-h-11 items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
                          active
                            ? 'bg-blue-500/20 text-white shadow-[inset_3px_0_0_rgb(96_165_250)]'
                            : 'text-slate-300 hover:bg-white/10 hover:text-white',
                        )}
                      >
                        <Icon className="h-5 w-5 shrink-0 text-slate-400 transition-colors group-hover:text-slate-200" aria-hidden="true" />
                        <span className="flex-1">{item.label}</span>
                        {badgeCount > 0 && (
                          <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-5 text-white">
                            {badgeCount > 99 ? '99+' : badgeCount}
                          </span>
                        )}
                      </Link>
                    )
                  })}
                </section>
              ))}
            </nav>

            <div className="flex shrink-0 items-center gap-3 border-t border-white/10 p-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-blue-100" aria-hidden="true">
                {fullName?.slice(0, 1) || '用'}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-white">{fullName ?? '用户'}</div>
                <div className="text-xs text-slate-400">{ROLE_LABELS[role]}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
