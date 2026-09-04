'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  approveUser,
  deleteUser,
  setUserRole,
  updateUserChineseName,
} from '@/lib/actions/users'
import { ResetPasswordDialog } from './reset-password-dialog'
import { formatDate } from '@/lib/utils'
import type { Profile, UserRole } from '@/types'

interface UserTableProps {
  users: Pick<
    Profile,
    'id' | 'email' | 'full_name' | 'chinese_name' | 'role' | 'status' | 'created_at'
  >[]
  currentUserId: string
  currentUserRole: UserRole
}

function ChineseNameEditor({ userId, initialValue }: { userId: string; initialValue: string | null }) {
  const router = useRouter()
  const [value, setValue] = useState(initialValue ?? '')
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    setValue(initialValue ?? '')
  }, [initialValue])

  const normalizedValue = value.trim()
  const unchanged = normalizedValue === (initialValue ?? '')

  function handleSave() {
    startTransition(async () => {
      const result = await updateUserChineseName(userId, normalizedValue)
      if (result.ok) {
        setValue(normalizedValue)
        toast.success(normalizedValue ? '中文名已更新' : '中文名已清空')
        router.refresh()
      } else {
        toast.error(result.error ?? '保存失败')
      }
    })
  }

  return (
    <div className="flex min-w-44 items-center gap-2">
      <Input
        value={value}
        maxLength={50}
        placeholder="请输入中文名"
        disabled={pending}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !unchanged && !pending) handleSave()
        }}
      />
      <Button
        type="button"
        size="icon"
        variant="outline"
        disabled={pending || unchanged}
        aria-label="保存中文名"
        title="保存中文名"
        onClick={handleSave}
      >
        <Save className="h-4 w-4" />
      </Button>
    </div>
  )
}

export function UserTable({ users, currentUserId, currentUserRole }: UserTableProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const canAdministerUsers = currentUserRole === 'admin'
  const adminCount = users.filter((u) => u.role === 'admin').length
  const roleLabels: Record<UserRole, string> = {
    admin: '管理员',
    finance: '财务',
    sales: '业务员',
  }

  function handleRoleChange(id: string, nextRole: UserRole) {
    startTransition(async () => {
      const result = await setUserRole(id, nextRole)
      if (result.ok) {
        toast.success('用户角色已更新')
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
              <TableHead>中文名</TableHead>
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
                    <ChineseNameEditor userId={u.id} initialValue={u.chinese_name} />
                  </TableCell>
                  <TableCell>
                    {canAdministerUsers ? (
                      <Select
                        value={u.role}
                        disabled={pending || isSelf || lastAdmin}
                        onValueChange={(value) => handleRoleChange(u.id, value as UserRole)}
                      >
                        <SelectTrigger className="w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">管理员</SelectItem>
                          <SelectItem value="finance">财务</SelectItem>
                          <SelectItem value="sales">业务员</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant="outline">{roleLabels[u.role]}</Badge>
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
                    {canAdministerUsers ? (
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
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
            {users.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
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
