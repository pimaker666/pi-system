'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Download, Ban } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { voidProformaInvoice } from '@/lib/actions/pi'
import type { PiStatus } from '@/types'

export function PiActions({ id, status }: { id: string; status: PiStatus }) {
  const router = useRouter()
  const [voidOpen, setVoidOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [downloading, setDownloading] = useState(false)

  async function handleDownload() {
    setDownloading(true)
    try {
      // Stream the freshly rendered PDF from the on-demand route.
      const res = await fetch(`/api/pi/${id}/pdf`)
      if (!res.ok) throw new Error('下载失败')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${id}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error('下载失败，请重试')
    } finally {
      setDownloading(false)
    }
  }

  function handleVoid() {
    startTransition(async () => {
      const result = await voidProformaInvoice(id)
      if (result.ok) {
        toast.success('PI 已作废')
        setVoidOpen(false)
        router.refresh()
      } else {
        toast.error(result.error ?? '操作失败')
      }
    })
  }

  return (
    <div className="flex gap-2">
      <Button onClick={handleDownload} disabled={downloading}>
        <Download className="h-4 w-4" />
        {downloading ? '生成中…' : '下载 PDF'}
      </Button>

      {status === 'active' && (
        <Button variant="outline" className="text-destructive" onClick={() => setVoidOpen(true)}>
          <Ban className="h-4 w-4" />
          作废
        </Button>
      )}

      <AlertDialog open={voidOpen} onOpenChange={setVoidOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>作废此 PI？</AlertDialogTitle>
            <AlertDialogDescription>
              作废后该 PI 会标记为无效并加上 VOID 水印，但仍保留在历史记录中。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleVoid()
              }}
              disabled={pending}
            >
              {pending ? '处理中…' : '确认作废'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
