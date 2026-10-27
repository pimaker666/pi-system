'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { filterNavItems, NAV_GROUPS } from '@/components/layout/nav-config'
import { cn } from '@/lib/utils'
import type { UserRole } from '@/types'

export type SidebarMode = 'auto' | 'expanded' | 'collapsed'

const MODE_COOKIE = 'pi_sidebar_mode'

const WIDTH_CLASS: Record<SidebarMode, string> = {
  auto: 'w-16 md:w-[76px] xl:w-52',
  expanded: 'w-16 md:w-52',
  collapsed: 'w-16 md:w-[76px]',
}

const ITEM_CLASS: Record<SidebarMode, string> = {
  auto: 'flex-col justify-center gap-1 px-1 md:min-h-12 xl:flex-row xl:justify-start xl:gap-2.5 xl:px-2.5 xl:text-base',
  expanded: 'flex-col justify-center gap-1 px-1 md:min-h-12 md:flex-row md:justify-start md:gap-2.5 md:px-2.5 md:text-base',
  collapsed: 'flex-col justify-center gap-1 px-1 md:min-h-12',
}

const LABEL_CLASS: Record<SidebarMode, string> = {
  auto: 'w-full text-center text-[10px] leading-3 md:hidden xl:block xl:w-auto xl:flex-1 xl:text-left xl:text-base xl:leading-6',
  expanded: 'w-full text-center text-[10px] leading-3 md:w-auto md:flex-1 md:text-left md:text-base md:leading-6',
  collapsed: 'hidden',
}

const GROUP_LABEL_CLASS: Record<SidebarMode, string> = {
  auto: 'hidden xl:block px-3 pb-1 pt-1 text-sm font-medium tracking-wide text-slate-400',
  expanded: 'hidden md:block px-3 pb-1 pt-1 text-sm font-medium tracking-wide text-slate-400',
  collapsed: 'hidden',
}

const USER_TEXT_CLASS: Record<SidebarMode, string> = {
  auto: 'sr-only xl:not-sr-only',
  expanded: 'sr-only md:not-sr-only',
  collapsed: 'sr-only',
}

const BADGE_CLASS: Record<SidebarMode, string> = {
  auto: 'absolute right-1 top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-5 text-white xl:static xl:min-w-6 xl:text-xs xl:leading-6',
  expanded: 'absolute right-1 top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-5 text-white md:static md:min-w-6 md:text-xs md:leading-6',
  collapsed: 'absolute right-1 top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-5 text-white',
}

const NAV_CLASS: Record<SidebarMode, string> = {
  auto: 'px-2 py-4 md:py-5 xl:px-3',
  expanded: 'px-2 py-4 md:px-3 md:py-5',
  collapsed: 'px-2 py-4 md:py-5',
}

const FOOTER_CLASS: Record<SidebarMode, string> = {
  auto: 'flex flex-col items-center gap-2 p-3 xl:flex-row xl:justify-between xl:px-4',
  expanded: 'flex flex-col items-center gap-2 p-3 md:flex-row md:justify-between md:px-4',
  collapsed: 'flex flex-col items-center gap-2 p-3',
}

const COLLAPSE_BTN_CLASS: Record<SidebarMode, string> = {
  auto: 'hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/10 hover:text-white xl:inline-flex',
  expanded: 'hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/10 hover:text-white md:inline-flex',
  collapsed: 'hidden',
}

const EXPAND_BTN_CLASS: Record<SidebarMode, string> = {
  auto: 'hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/10 hover:text-white md:inline-flex xl:hidden',
  expanded: 'hidden',
  collapsed: 'hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/10 hover:text-white md:inline-flex',
}

export function Sidebar({
  role,
  fullName,
  canViewFinance = false,
  commissionAttentionCount = 0,
  mode: initialMode = 'auto',
}: {
  role: UserRole
  fullName: string | null
  canViewFinance?: boolean
  commissionAttentionCount?: number
  mode?: SidebarMode
}) {
  const [mode, setMode] = useState<SidebarMode>(initialMode)
  const updateMode = (next: SidebarMode) => {
    setMode(next)
    document.cookie = `${MODE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`
  }
  const pathname = usePathname()
  const attentionBadge = commissionAttentionCount > 99 ? '99+' : commissionAttentionCount
  const items = filterNavItems(role, canViewFinance)
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
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col border-r border-white/10 bg-[hsl(var(--sidebar-background))] text-slate-200 transition-[width] duration-200',
        WIDTH_CLASS[mode],
      )}
    >
      <nav className={cn('min-h-0 flex-1 space-y-5 overflow-y-auto', NAV_CLASS[mode])} aria-label="主导航">
        {groups.map((group, groupIndex) => (
          <section key={group.label ?? 'overview'} className="space-y-1" aria-label={group.label ?? '工作台'}>
            {group.label && <p className={GROUP_LABEL_CLASS[mode]}>{group.label}</p>}
            {group.items.map((item) => {
              const active = item.href === activeHref
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={item.label}
                  aria-label={item.label}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'group relative flex min-h-14 items-center rounded-lg py-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--sidebar-background))]',
                    ITEM_CLASS[mode],
                    active
                      ? 'bg-blue-500/20 text-white shadow-[inset_3px_0_0_rgb(96_165_250)]'
                      : 'text-slate-300 hover:bg-white/10 hover:text-white',
                  )}
                >
                  <Icon className="h-5 w-5 shrink-0 text-slate-400 transition-colors group-hover:text-slate-200 md:h-6 md:w-6" aria-hidden="true" />
                  <span className={LABEL_CLASS[mode]}>{item.label}</span>
                  {item.attentionBadge && commissionAttentionCount > 0 && (
                    <span className={BADGE_CLASS[mode]}>{attentionBadge}</span>
                  )}
                </Link>
              )
            })}
            {groupIndex === 0 && <div className="hidden md:block" />}
          </section>
        ))}
      </nav>

      <div className={cn('shrink-0 border-t border-white/10', FOOTER_CLASS[mode])}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-sm font-semibold text-blue-100" aria-hidden="true">
            {fullName?.slice(0, 1) || '用'}
          </div>
          <div className={cn('min-w-0', USER_TEXT_CLASS[mode])}>
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
        <button
          type="button"
          onClick={() => updateMode('collapsed')}
          title="收起侧边栏"
          aria-label="收起侧边栏"
          className={COLLAPSE_BTN_CLASS[mode]}
        >
          <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => updateMode('expanded')}
          title="展开侧边栏"
          aria-label="展开侧边栏"
          className={EXPAND_BTN_CLASS[mode]}
        >
          <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </aside>
  )
}
