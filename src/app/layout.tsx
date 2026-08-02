import type { Metadata } from 'next'
import localFont from 'next/font/local'
import './globals.css'
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

export const metadata: Metadata = {
  title: 'PI 自动生成系统',
  description: '产品库与 Proforma Invoice 自动生成系统',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className={inter.className}>
        {children}
        <Toaster />
      </body>
    </html>
  )
}
