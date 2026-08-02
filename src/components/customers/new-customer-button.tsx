'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { CustomerFormFields } from './customer-form-fields'
import type { CustomerGroup } from '@/types'

export function NewCustomerButton({ groups }: { groups: CustomerGroup[] }) {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" />
          新增客户
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增客户</DialogTitle>
        </DialogHeader>
        <CustomerFormFields
          groups={groups}
          onSuccess={() => {
            setOpen(false)
            router.refresh()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
