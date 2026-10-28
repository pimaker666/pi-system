import type { Metadata } from 'next'
import localFont from 'next/font/local'
import './globals.css'
import { DynamicPageTitle } from '@/components/layout/dynamic-page-title'
import { Toaster } from '@/components/ui/sonner'

// Use the locally shipped Inter .ttf (see public/fonts) instead of fetching
// from Google Fonts at build time — keeps builds offline-safe.
const inter = localFont({
  src: [
    { path: '../../public/fonts/Inter-Regular.ttf', weight: '400', style: 'normal' },
    { path: '../../public/fonts/Inter-Bold.ttf', weight: '700', style: 'normal' },
  ],
  display: 'swap',
})

// 站点标题由 DynamicPageTitle 按路由动态渲染（React 19 将 <title> 提升到 head）。
// 不在 metadata 里写死 title，否则 head 里会同时存在静态 <title> 且排在最前，
// document.title 永远读到静态值。
export const metadata: Metadata = {
  description: '产品库与 Proforma Invoice 自动生成系统',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className={inter.className}>
        {children}
        <DynamicPageTitle />
        <Toaster />
      </body>
    </html>
  )
}
