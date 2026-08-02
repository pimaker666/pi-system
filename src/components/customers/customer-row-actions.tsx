'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil, Trash2, ArrowRightLeft, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { CustomerFormFields } from './customer-form-fields'
import { deleteCustomer, transferCustomer, copyCustomer } from '@/lib/actions/customers'
import type { Customer, CustomerGroup } from '@/types'
import type { OwnerOption } from '@/components/shared/owner-filter'

export function CustomerRowActions({
  customer,
  groups,
  isAdmin = false,
  owners = [],
}: {
  customer: Customer
  groups: CustomerGroup[]
  isAdmin?: boolean
  owners?: OwnerOption[]
}) {
  const router = useRouter()
  const [editOpen, setEditOpen] = useState(false)
  const [delOpen, setDelOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [moveMode, setMoveMode] = useState<'transfer' | 'copy'>('transfer')
  const [targetId, setTargetId] = useState('')
  const [pending, startTransition] = useTransition()

  // 可选目标账号：排除当前归属者
  const targets = owners.filter((o) => o.id !== customer.created_by)

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteCustomer(customer.id)
      if (result.ok) {
        toast.success('客户已删除')
        setDelOpen(false)
        router.refresh()
      } else {
        toast.error(result.error ?? '删除失败')
      }
    })
  }

  function openMove(mode: 'transfer' | 'copy') {
    setMoveMode(mode)
    setTargetId('')
    setMoveOpen(true)
  }

  function handleMove() {
    if (!targetId) {
      toast.error('请选择目标账号')
      return
    }
    startTransition(async () => {
      const result =
        moveMode === 'transfer'
          ? await transferCustomer(customer.id, targetId)
          : await copyCustomer(customer.id, targetId)
      if (result.ok) {
        toast.success(moveMode === 'transfer' ? '客户已转移（含其 PI）' : '客户已复制')
        setMoveOpen(false)
        router.refresh()
      } else {
        toast.error(result.error ?? '操作失败')
      }
    })
  }

  return (
    <div className="flex justify-end gap-1">
      {targets.length > 0 && (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title="转移到其他账号（含 PI）"
            onClick={() => openMove('transfer')}
          >
            <ArrowRightLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title="复制到其他账号"
            onClick={() => openMove('copy')}
          >
            <Copy className="h-4 w-4" />
          </Button>
        </>
      )}
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditOpen(true)}>
        <Pencil className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-destructive"
        onClick={() => setDelOpen(true)}
      >
        <Trash2 className="h-4 w-4" />
      </Button>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑客户</DialogTitle>
          </DialogHeader>
          <CustomerFormFields
            customer={customer}
            groups={groups}
            onSuccess={() => {
              setEditOpen(false)
              router.refresh()
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {moveMode === 'transfer' ? '转移客户' : '复制客户'}「{customer.name}」
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>目标账号</Label>
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger>
                <SelectValue placeholder="选择账号" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {moveMode === 'transfer'
                ? '转移后该客户及其名下已开的 PI 将归属所选账号。'
                : '复制会为所选账号新建一份相同客户信息，不复制 PI。'}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveOpen(false)}>
              取消
            </Button>
            <Button onClick={handleMove} disabled={pending}>
              {pending ? '处理中…' : '确定'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={delOpen} onOpenChange={setDelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除客户「{customer.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              已生成的 PI 会保留客户信息快照，不受影响。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleDelete()
              }}
              disabled={pending}
            >
              {pending ? '删除中…' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
