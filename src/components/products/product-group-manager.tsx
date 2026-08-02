'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Pencil, Trash2, Boxes, ArrowUp, ArrowDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
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
import {
  createProductGroup,
  updateProductGroup,
  deleteProductGroup,
  reorderProductGroups,
} from '@/lib/actions/product-groups'
import type { ProductGroup } from '@/types'

export interface ProductGroupWithCount extends ProductGroup {
  product_count: number
}

function GroupDialog({
  group,
  trigger,
}: {
  group?: ProductGroup
  trigger: React.ReactNode
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = group
        ? await updateProductGroup(group.id, formData)
        : await createProductGroup(formData)
      if (result.ok) {
        toast.success(group ? '分组已更新' : '分组已创建')
        setOpen(false)
        router.refresh()
      } else {
        toast.error(result.error ?? '保存失败')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{group ? '编辑分组' : '新增分组'}</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">分组名称 *</Label>
            <Input id="name" name="name" defaultValue={group?.name} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">描述</Label>
            <Textarea id="description" name="description" defaultValue={group?.description ?? ''} />
          </div>
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? '保存中…' : '保存'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function GroupCard({
  group,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  reordering,
}: {
  group: ProductGroupWithCount
  onMoveUp: () => void
  onMoveDown: () => void
  isFirst: boolean
  isLast: boolean
  reordering: boolean
}) {
  const router = useRouter()
  const [delOpen, setDelOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteProductGroup(group.id)
      if (result.ok) {
        toast.success('分组已删除')
        setDelOpen(false)
        router.refresh()
      } else {
        toast.error(result.error ?? '删除失败')
      }
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{group.name}</CardTitle>
          {group.description && (
            <p className="text-sm text-muted-foreground">{group.description}</p>
          )}
        </div>
        <Badge variant="secondary">{group.product_count} 产品</Badge>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={onMoveUp}
          disabled={isFirst || reordering}
          title="上移"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={onMoveDown}
          disabled={isLast || reordering}
          title="下移"
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
        <GroupDialog
          group={group}
          trigger={
            <Button variant="outline" size="sm">
              <Pencil className="h-3.5 w-3.5" />
              编辑
            </Button>
          }
        />
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          onClick={() => setDelOpen(true)}
        >
          <Trash2 className="h-3.5 w-3.5" />
          删除
        </Button>

        <AlertDialog open={delOpen} onOpenChange={setDelOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除分组「{group.name}」？</AlertDialogTitle>
              <AlertDialogDescription>
                该分组下的产品将变为「未分组」，产品本身不会被删除。
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
      </CardContent>
    </Card>
  )
}

export function ProductGroupManager({ groups }: { groups: ProductGroupWithCount[] }) {
  const router = useRouter()
  const [order, setOrder] = useState<ProductGroupWithCount[]>(groups)
  const [reordering, startReorder] = useTransition()

  // Keep local order in sync when server data changes (e.g. after create/delete).
  const groupsKey = groups.map((g) => g.id).join(',')
  const [lastKey, setLastKey] = useState(groupsKey)
  if (groupsKey !== lastKey) {
    setLastKey(groupsKey)
    setOrder(groups)
  }

  function persist(next: ProductGroupWithCount[]) {
    setOrder(next)
    startReorder(async () => {
      const result = await reorderProductGroups(next.map((g) => g.id))
      if (result.ok) {
        router.refresh()
      } else {
        toast.error(result.error ?? '排序保存失败')
        setOrder(groups)
        router.refresh()
      }
    })
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir
    if (target < 0 || target >= order.length) return
    const next = [...order]
    ;[next[index], next[target]] = [next[target], next[index]]
    persist(next)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          用上移 / 下移调整顺序，该顺序会用于开具 PI 时的产品分组展示。
        </p>
        <GroupDialog
          trigger={
            <Button>
              <Plus className="h-4 w-4" />
              新增分组
            </Button>
          }
        />
      </div>

      {order.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed p-12 text-center text-muted-foreground">
          <Boxes className="h-8 w-8" />
          <p>还没有分组，点击右上角创建第一个分组</p>
        </div>
      ) : (
        <div className="space-y-3">
          {order.map((g, index) => (
            <GroupCard
              key={g.id}
              group={g}
              onMoveUp={() => move(index, -1)}
              onMoveDown={() => move(index, 1)}
              isFirst={index === 0}
              isLast={index === order.length - 1}
              reordering={reordering}
            />
          ))}
        </div>
      )}
    </div>
  )
}
