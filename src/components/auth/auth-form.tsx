'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { toast } from 'sonner'
import { login, signup, type AuthState } from '@/lib/actions/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? '处理中…' : label}
    </Button>
  )
}

export function AuthForm({ initialError }: { initialError?: string }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const action = mode === 'login' ? login : signup

  const [state, formAction] = useActionState<AuthState, FormData>(
    async (prev, formData) => {
      const result = await action(prev, formData)
      if (mode === 'signup' && !result.error) {
        toast.success('注册成功，请查收邮箱完成验证后登录')
        setMode('login')
      }
      return result
    },
    { error: initialError },
  )

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-semibold">{mode === 'login' ? '登录' : '注册'}</h1>
        <p className="text-sm text-muted-foreground">PI 自动生成系统</p>
      </div>

      <form action={formAction} className="space-y-4">
        {mode === 'signup' && (
          <div className="space-y-2">
            <Label htmlFor="full_name">姓名</Label>
            <Input id="full_name" name="full_name" placeholder="张三" />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="email">邮箱</Label>
          <Input id="email" name="email" type="email" required placeholder="you@example.com" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">密码</Label>
          <Input id="password" name="password" type="password" required placeholder="••••••" />
        </div>

        {state.error && <p className="text-sm text-destructive">{state.error}</p>}

        <SubmitButton label={mode === 'login' ? '登录' : '注册'} />
      </form>

      <p className="text-center text-sm text-muted-foreground">
        {mode === 'login' ? '还没有账号？' : '已有账号？'}{' '}
        <button
          type="button"
          className="font-medium text-primary hover:underline"
          onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
        >
          {mode === 'login' ? '去注册' : '去登录'}
        </button>
      </p>
    </div>
  )
}
