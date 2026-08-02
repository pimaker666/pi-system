'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { getPiForClone } from '@/lib/actions/pi'
import { usePiCartStore } from '@/stores/pi-cart-store'
import type { ProformaInvoiceWithItems } from '@/types'
import { cn } from '@/lib/utils'

interface PiCloneButtonProps {
  /** Either provide the id (fetched on click) or a preloaded pi. */
  id?: string
  pi?: ProformaInvoiceWithItems
  compact?: boolean
  className?: string
}

/**
 * Import a historical PI into the create page. The old PI is untouched — the
 * user modifies the prefilled cart and generates a brand-new PI.
 */
export function PiCloneButton({ id, pi, compact = false, className }: PiCloneButtonProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const hydrateFromPi = usePiCartStore((s) => s.hydrateFromPi)

  const handleClone = () => {
    startTransition(async () => {
      const source = pi ?? (id ? await getPiForClone(id) : null)
      if (!source) {
        toast.error('无法载入该 PI')
        return
      }
      hydrateFromPi(source)
      toast.success('已导入，可修改后生成新 PI')
      router.push('/pi/create')
    })
  }

  if (compact) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className={cn('h-8 w-8', className)}
        title="克隆开单"
        disabled={pending}
        onClick={handleClone}
      >
        <Copy className="h-4 w-4" />
      </Button>
    )
  }

  return (
    <Button variant="outline" className={className} disabled={pending} onClick={handleClone}>
      <Copy className="h-4 w-4" />
      克隆开单
    </Button>
  )
}
