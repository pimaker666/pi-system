'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { NAV } from '@/components/layout/nav-config'

const APP_TITLE = 'PI 自动生成系统'

// 侧边栏未收录的独立页：标签页标题直接用页面名
const EXTRA_TITLES: Record<string, string> = {
  '/login': '登录',
  '/pending': '待审核',
}

export function DynamicPageTitle() {
  const pathname = usePathname()

  useEffect(() => {
    const nav = NAV.find((item) =>
      item.match ? item.match(pathname) : pathname === item.href || pathname.startsWith(`${item.href}/`),
    )
    const page = nav?.label ?? EXTRA_TITLES[pathname] ?? null
    document.title = page ? `${page} - ${APP_TITLE}` : APP_TITLE
    return () => {
      document.title = APP_TITLE
    }
  }, [pathname])

  return null
}
