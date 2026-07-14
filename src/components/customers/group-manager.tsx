'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Pencil, Trash2, UsersRound } from 'lucide-react'
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
import { createGroup, updateGroup, deleteGroup } from '@/lib/actions/groups'
import type { CustomerGroup } from '@/types'

export interface GroupWithCount extends CustomerGroup {
  customer_count: number
}

function GroupDialog({
  group,
  trigger,
}: {
  group?: CustomerGroup
  trigger: React.ReactNode
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = group ? await updateGroup(group.id, formData) : await createGroup(formData)
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

function GroupCard({ group }: { group: GroupWithCount }) {
  const router = useRouter()
  const [delOpen, setDelOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteGroup(group.id)
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
        <Badge variant="secondary">{group.customer_count} 客户</Badge>
      </CardHeader>
      <CardContent className="flex gap-2">
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
                该分组下的客户将变为「未分组」，客户本身不会被删除。
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

export function GroupManager({ groups }: { groups: GroupWithCount[] }) {
  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <GroupDialog
          trigger={
            <Button>
              <Plus className="h-4 w-4" />
              新增分组
            </Button>
          }
        />
      </div>

      {groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed p-12 text-center text-muted-foreground">
          <UsersRound className="h-8 w-8" />
          <p>还没有分组，点击右上角创建第一个分组</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <GroupCard key={g.id} group={g} />
          ))}
        </div>
      )}
    </div>
  )
}
