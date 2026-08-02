'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { resetUserPassword } from '@/lib/actions/users'

/**
 * Admin dialog to set a new login password for a given user.
 * Enter + confirm the new password; on success the user logs in with it next time.
 */
export function ResetPasswordDialog({
  userId,
  email,
  disabled,
}: {
  userId: string
  email: string
  disabled?: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function handleSubmit(formData: FormData) {
    const password = String(formData.get('password') ?? '')
    const confirm = String(formData.get('confirm') ?? '')
    if (password.length < 6) {
      toast.error('密码至少需要 6 位')
      return
    }
    if (password !== confirm) {
      toast.error('两次输入的密码不一致')
      return
    }
    startTransition(async () => {
      const result = await resetUserPassword(userId, formData)
      if (result.ok) {
        toast.success('密码已重置，请把新密码告知该用户')
        setOpen(false)
        router.refresh()
      } else {
        toast.error(result.error ?? '重置失败')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          <KeyRound className="h-3.5 w-3.5" />
          改密码
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重置密码</DialogTitle>
          <DialogDescription>
            为「{email}」设置新的登录密码，保存后该用户需用新密码登录。
          </DialogDescription>
        </DialogHeader>
        <form action={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-password">新密码</Label>
            <Input
              id="new-password"
              name="password"
              type="password"
              placeholder="至少 6 位"
              autoComplete="new-password"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">确认新密码</Label>
            <Input
              id="confirm-password"
              name="confirm"
              type="password"
              placeholder="再次输入新密码"
              autoComplete="new-password"
              required
            />
          </div>
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? '重置中…' : '确认重置'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
