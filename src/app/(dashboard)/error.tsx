'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
      <h2 className="text-lg font-semibold">页面加载失败</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        数据读取时出现异常，可先重试；若持续失败请把下方错误信息反馈给管理员。
      </p>
      {error.digest && (
        <p className="text-xs text-muted-foreground">错误编号：{error.digest}</p>
      )}
      <Button onClick={reset}>重试</Button>
    </div>
  )
}
