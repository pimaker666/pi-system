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

function pageTitleForPath(pathname: string): string {
  const nav =
    // 1. 纯 href 精确命中（优先于自定义 match，避免 /users 的 match 抢走 /users/permissions）
    NAV.find((item) => !item.match && item.href === pathname) ??
    // 2. 自定义 match（PI 历史、产品库、权限管理等排除型规则）
    NAV.find((item) => !!item.match && item.match!(pathname)) ??
    // 3. 前缀兜底（如 /finance 之下的未知子页归入「财务总览」）
    NAV.find((item) => !item.match && pathname.startsWith(`${item.href}/`))
  const page = nav?.label ?? EXTRA_TITLES[pathname] ?? null
  return page ? `${page} - ${APP_TITLE}` : APP_TITLE
}

export function DynamicPageTitle() {
  const pathname = usePathname()
  const title = pageTitleForPath(pathname)
  // 渲染真实 <title> 元素交给 React 19 提升到 head；useEffect 兜底再写一次 document.title
  useEffect(() => {
    document.title = title
  }, [title])
  return <title>{title}</title>
}
