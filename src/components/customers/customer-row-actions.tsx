'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil, Trash2, ArrowRightLeft, Copy, Tag } from 'lucide-react'
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
import { deleteCustomer, transferCustomer, copyCustomer, updateCustomerTagColor } from '@/lib/actions/customers'
import type { Customer, CustomerGroup, CustomerCommissionTag } from '@/types'
import type { OwnerOption } from '@/components/shared/owner-filter'

export function CustomerRowActions({
  customer,
  groups,
  isAdmin = false,
  owners = [],
  customerTags = [],
}: {
  customer: Customer
  groups: CustomerGroup[]
  isAdmin?: boolean
  owners?: OwnerOption[]
  customerTags?: CustomerCommissionTag[]
}) {
  const router = useRouter()
  const [editOpen, setEditOpen] = useState(false)
  const [delOpen, setDelOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const [tagColor, setTagColor] = useState(customer.tag_color ?? '')
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
        toast.success(moveMode === 'transfer' ? '客户已转移，历史 PI 保持不变' : '客户已复制')
        setMoveOpen(false)
        router.refresh()
      } else {
        toast.error(result.error ?? '操作失败')
      }
    })
  }

  function handleTagSave() {
    const color = tagColor.trim() || null
    startTransition(async () => {
      const result = await updateCustomerTagColor(customer.id, color)
      if (result.ok) {
        toast.success(color ? '客户标记已保存' : '客户标记已清除')
        setTagOpen(false)
        router.refresh()
      } else {
        toast.error(result.error ?? '保存失败')
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
            title="转移客户当前负责人"
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
      {isAdmin && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="客户标记"
          onClick={() => {
            setTagColor(customer.tag_color ?? '')
            setTagOpen(true)
          }}
        >
          <Tag className="h-4 w-4" style={{ color: customer.tag_color ?? undefined }} />
        </Button>
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

      <Dialog open={tagOpen} onOpenChange={setTagOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>客户标记</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              为「{customer.name}」选择预定义标记，订单提成会优先按标记对应的产品提点计算。
            </p>
            {customerTags.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                暂无预定义标记，请先在「业务提成」页配置标记库。
              </p>
            ) : (
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => setTagColor('')}
                  className={`flex w-full items-center gap-2 rounded-md border-2 px-3 py-2 text-left text-sm transition hover:bg-accent ${
                    tagColor === '' ? 'border-foreground' : 'border-transparent'
                  }`}
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border text-[10px] text-muted-foreground">
                    无
                  </span>
                  <span>清除标记</span>
                </button>
                {customerTags.map((tag) => (
                  <button
                    key={tag.tag_color}
                    type="button"
                    onClick={() => setTagColor(tag.tag_color)}
                    className={`flex w-full items-center gap-2 rounded-md border-2 px-3 py-2 text-left text-sm transition hover:bg-accent ${
                      tagColor === tag.tag_color ? 'border-foreground' : 'border-transparent'
                    }`}
                  >
                    <span
                      className="h-5 w-5 rounded-full border"
                      style={{ backgroundColor: tag.tag_color }}
                    />
                    <span className="flex-1" style={{ color: tag.tag_color }}>
                      {tag.label}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {tag.product_commission_rate}%
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTagOpen(false)}>
              取消
            </Button>
            <Button onClick={handleTagSave} disabled={pending || customerTags.length === 0}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
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
                ? '转移只改变该客户的当前负责人；历史 PI 的归属与创建人保持不变。'
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
