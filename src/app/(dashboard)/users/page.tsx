import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth'
import { UserTable } from '@/components/users/user-table'
import type { Profile } from '@/types'

export default async function UsersPage() {
  const me = await requireAdmin()
  const supabase = await createClient()

  const { data } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, status, created_at')
    .order('created_at', { ascending: true })

  const users = (data ?? []) as Pick<
    Profile,
    'id' | 'email' | 'full_name' | 'role' | 'status' | 'created_at'
  >[]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">用户管理</h1>
        <p className="text-sm text-muted-foreground">
          新注册的用户需管理员「通过审核」后才能登录使用；管理员还可提升/取消他人的管理员身份，或删除用户账号。
        </p>
      </div>

      <UserTable users={users} currentUserId={me.id} />
    </div>
  )
}
