'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

export interface AuthState {
  error?: string
}

export async function login(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')

  if (!email || !password) {
    return { error: '请输入邮箱和密码' }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    return { error: '邮箱或密码错误' }
  }

  revalidatePath('/', 'layout')
  redirect('/dashboard')
}

export async function signup(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const fullName = String(formData.get('full_name') ?? '').trim()

  if (!email || !password) {
    return { error: '请输入邮箱和密码' }
  }
  if (password.length < 6) {
    return { error: '密码至少 6 位' }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
    },
  })
  if (error) {
    return { error: error.message }
  }

  return { error: undefined }
}

export async function changeOwnPassword(input: {
  currentPassword: string
  newPassword: string
}): Promise<{ ok: boolean; error?: string }> {
  if (input.newPassword.length < 6) {
    return { ok: false, error: '新密码至少需要 6 位' }
  }
  if (input.currentPassword === input.newPassword) {
    return { ok: false, error: '新密码不能与当前密码相同' }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.email) return { ok: false, error: '登录状态已失效，请重新登录' }

  const { error: verifyError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: input.currentPassword,
  })
  if (verifyError) return { ok: false, error: '当前密码不正确' }

  const { error } = await supabase.auth.updateUser({ password: input.newPassword })
  if (error) return { ok: false, error: error.message }

  revalidatePath('/', 'layout')
  return { ok: true }
}

export async function logout(): Promise<void> {
  const supabase = await createClient()
  await supabase.auth.signOut()
  revalidatePath('/', 'layout')
  redirect('/login')
}
