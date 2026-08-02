'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ShieldCheck, ShieldOff, Check, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { setUserRole, approveUser, deleteUser } from '@/lib/actions/users'
import { ResetPasswordDialog } from './reset-password-dialog'
import { formatDate } from '@/lib/utils'
import type { Profile } from '@/types'

interface UserTableProps {
  users: Pick<Profile, 'id' | 'email' | 'full_name' | 'role' | 'status' | 'created_at'>[]
  currentUserId: string
}

export function UserTable({ users, currentUserId }: UserTableProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const adminCount = users.filter((u) => u.role === 'admin').length

  function handleToggle(id: string, nextRole: 'admin' | 'sales') {
    startTransition(async () => {
      const result = await setUserRole(id, nextRole)
      if (result.ok) {
        toast.success(nextRole === 'admin' ? '已设为管理员' : '已取消管理员')
        router.refresh()
      } else {
        toast.error(result.error ?? '操作失败')
      }
    })
  }

  function handleApprove(id: string) {
    startTransition(async () => {
      const result = await approveUser(id)
      if (result.ok) {
        toast.success('已通过审核，该用户现在可以登录使用')
        router.refresh()
      } else {
        toast.error(result.error ?? '操作失败')
      }
    })
  }

  function handleDelete(id: string, email: string) {
    if (!window.confirm(`确定删除用户「${email}」吗？此操作不可撤销，将永久删除其账号。`)) {
      return
    }
    startTransition(async () => {
      const result = await deleteUser(id)
      if (result.ok) {
        toast.success('用户已删除')
        router.refresh()
      } else {
        toast.error(result.error ?? '删除失败')
      }
    })
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>邮箱</TableHead>
              <TableHead>姓名</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>注册时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => {
              const isSelf = u.id === currentUserId
              const isAdmin = u.role === 'admin'
              const isPending = u.status !== 'approved'
              // Prevent demoting/deleting the last remaining admin.
              const lastAdmin = isAdmin && adminCount <= 1
              return (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.email}</TableCell>
                  <TableCell>{u.full_name ?? '—'}</TableCell>
                  <TableCell>
                    {isAdmin ? (
                      <Badge variant="default">管理员</Badge>
                    ) : (
                      <Badge variant="secondary">业务员</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {isPending ? (
                      <Badge variant="destructive">待审核</Badge>
                    ) : (
                      <Badge variant="outline">已通过</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(u.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {isPending && (
                        <Button
                          size="sm"
                          disabled={pending}
                          onClick={() => handleApprove(u.id)}
                        >
                          <Check className="h-3.5 w-3.5" />
                          通过审核
                        </Button>
                      )}

                      {!isPending &&
                        (isAdmin ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-destructive"
                            disabled={pending || isSelf || lastAdmin}
                            title={
                              isSelf
                                ? '不能修改自己的角色'
                                : lastAdmin
                                  ? '至少需保留一名管理员'
                                  : undefined
                            }
                            onClick={() => handleToggle(u.id, 'sales')}
                          >
                            <ShieldOff className="h-3.5 w-3.5" />
                            取消管理员
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={() => handleToggle(u.id, 'admin')}
                          >
                            <ShieldCheck className="h-3.5 w-3.5" />
                            设为管理员
                          </Button>
                        ))}

                      <ResetPasswordDialog userId={u.id} email={u.email} />

                      <Button
                        size="sm"
                        variant="outline"
                        className="text-destructive"
                        disabled={pending || isSelf || lastAdmin}
                        title={
                          isSelf
                            ? '不能删除自己的账号'
                            : lastAdmin
                              ? '至少需保留一名管理员'
                              : undefined
                        }
                        onClick={() => handleDelete(u.id, u.email)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
            {users.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  暂无注册用户
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
