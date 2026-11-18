'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { FileText, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { UserRole } from '@/types'
import { NavLinks, ROLE_LABELS } from './sidebar'

/** Mobile-only hamburger + slide-in nav drawer (desktop uses the sidebar). */
export function MobileNav({
  role,
  fullName,
}: {
  role: UserRole
  fullName: string | null
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

  return (
    <div className="print-chrome lg:hidden">
      <Button
        variant="ghost"
        size="sm"
        className="h-9 w-9 p-0"
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
            className="absolute inset-0 bg-black/45"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col border-r bg-background shadow-xl">
            <div className="flex h-16 items-center justify-between border-b px-4">
              <div className="flex items-center gap-2">
                <FileText className="h-6 w-6 text-primary" />
                <span className="text-lg font-semibold">PI 系统</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => setOpen(false)}
                aria-label="关闭导航"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <NavLinks role={role} />
            <div className="border-t p-4">
              <div className="text-sm font-medium">{fullName ?? '用户'}</div>
              <div className="text-xs text-muted-foreground">
                {ROLE_LABELS[role]}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
