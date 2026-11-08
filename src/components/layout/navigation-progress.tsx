'use client'

import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const MAX_DURATION_MS = 8000

/**
 * 顶部细进度条。App Router 没有路由事件，这里在点击站内同标签页链接时启动，
 * 等 pathname 变化后收尾；只处理跨路径跳转，带查询参数的页内筛选不会误触发。
 */
export function NavigationProgress() {
  const pathname = usePathname()
  const [visible, setVisible] = useState(false)
  const [progress, setProgress] = useState(0)
  const timers = useRef<number[]>([])
  const active = useRef(false)

  const clearTimers = useCallback(() => {
    timers.current.forEach((id) => window.clearTimeout(id))
    timers.current = []
  }, [])

  const finish = useCallback(() => {
    if (!active.current) return
    active.current = false
    clearTimers()
    setProgress(100)
    timers.current.push(
      window.setTimeout(() => {
        setVisible(false)
        setProgress(0)
      }, 220),
    )
  }, [clearTimers])

  useEffect(() => {
    finish()
    return clearTimers
  }, [pathname, finish, clearTimers])

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a')
      if (!(anchor instanceof HTMLAnchorElement)) return
      if (anchor.target && anchor.target !== '_self') return
      if (anchor.hasAttribute('download')) return

      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      if (url.pathname === window.location.pathname) return

      active.current = true
      clearTimers()
      setVisible(true)
      setProgress(12)
      timers.current.push(window.setTimeout(() => setProgress(45), 150))
      timers.current.push(window.setTimeout(() => setProgress(70), 700))
      timers.current.push(window.setTimeout(() => setProgress(88), 1800))
      timers.current.push(window.setTimeout(finish, MAX_DURATION_MS))
    }

    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [clearTimers, finish])

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 transition-opacity duration-200',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div
        className="h-full bg-primary transition-[width] duration-300 ease-out"
        style={{ width: `${progress}%` }}
      />
    </div>
  )
}
