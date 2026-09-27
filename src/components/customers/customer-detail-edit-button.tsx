'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CustomerFormFields } from './customer-form-fields'
import type { Customer, CustomerGroup } from '@/types'

export function CustomerDetailEditButton({
  customer,
  groups,
}: {
  customer: Customer
  groups: CustomerGroup[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Pencil className="h-4 w-4" />
        编辑客户
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑客户</DialogTitle>
          </DialogHeader>
          <CustomerFormFields
            customer={customer}
            groups={groups}
            onSuccess={() => {
              setOpen(false)
              router.refresh()
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
