import { redirect } from 'next/navigation'
import { getCurrentProfile } from '@/lib/auth'
import { LogoutButton } from '@/components/auth/logout-button'

export default async function PendingPage() {
  const profile = await getCurrentProfile()
  if (!profile) redirect('/login')
  if (profile.status === 'approved') redirect('/dashboard')

  const disabled = profile.status === 'disabled'

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-md rounded-lg border bg-background p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold">{disabled ? '账号已停用' : '账号待审核'}</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {disabled
            ? `你的账号（${profile.email}）已停用，暂时无法使用系统。请联系管理员恢复账号。`
            : `你的账号（${profile.email}）已注册成功，需要管理员审核通过后才能使用系统。请联系管理员开通，通过后重新登录即可。`}
        </p>
        <div className="mt-6 flex justify-center">
          <LogoutButton />
        </div>
      </div>
    </div>
  )
}
