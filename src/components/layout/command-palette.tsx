'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { filterNavItems, NAV_GROUPS } from '@/components/layout/nav-config'
import type { UserRole } from '@/types'

export function CommandPalette({
  role,
  canViewFinance,
}: {
  role: UserRole
  canViewFinance: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  const groups = useMemo(() => {
    const items = filterNavItems(role, canViewFinance)
    return NAV_GROUPS.map((group) => ({
      label: group.label,
      items: items.filter((item) => group.hrefs.includes(item.href)),
    })).filter((group) => group.items.length > 0)
  }, [role, canViewFinance])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const select = (href: string) => {
    setOpen(false)
    router.push(href)
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="gap-2 text-muted-foreground"
        aria-label="搜索页面（Ctrl/⌘ K）"
      >
        <Search className="h-4 w-4" />
        <span className="hidden sm:inline">搜索页面</span>
        <kbd className="hidden rounded border bg-muted px-1.5 font-sans text-[10px] font-medium sm:inline">
          ⌘K
        </kbd>
      </Button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/60 px-4 pt-[12vh] backdrop-blur-sm"
          onMouseDown={() => setOpen(false)}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border bg-popover shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <Command onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false)
            }}>
              <CommandInput placeholder="搜索页面，回车跳转…" autoFocus />
              <CommandList>
                <CommandEmpty>没有匹配的页面</CommandEmpty>
                {groups.map((group) => (
                  <CommandGroup key={group.label ?? 'overview'} heading={group.label ?? '工作台'}>
                    {group.items.map((item) => {
                      const Icon = item.icon
                      return (
                        <CommandItem
                          key={item.href}
                          value={`${item.label} ${item.href}`}
                          onSelect={() => select(item.href)}
                        >
                          <Icon className="mr-2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                          {item.label}
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          </div>
        </div>
      )}
    </>
  )
}
