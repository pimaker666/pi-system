'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { changeOwnPassword } from '@/lib/actions/auth'

export function ChangePasswordForm() {
  const [pending, startTransition] = useTransition()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (newPassword.length < 6) {
      toast.error('新密码至少需要 6 位')
      return
    }
    if (newPassword !== confirmPassword) {
      toast.error('两次输入的新密码不一致')
      return
    }

    startTransition(async () => {
      const result = await changeOwnPassword({ currentPassword, newPassword })
      if (!result.ok) {
        toast.error(result.error ?? '密码修改失败')
        return
      }
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      toast.success('密码已修改')
    })
  }

  return (
    <form className="max-w-md space-y-4" onSubmit={handleSubmit}>
      <div className="space-y-2">
        <Label htmlFor="current-password">当前密码</Label>
        <Input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="new-password">新密码</Label>
        <Input id="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少 6 位" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm-new-password">确认新密码</Label>
        <Input id="confirm-new-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required />
      </div>
      <Button type="submit" disabled={pending}>{pending ? '保存中…' : '修改密码'}</Button>
    </form>
  )
}
