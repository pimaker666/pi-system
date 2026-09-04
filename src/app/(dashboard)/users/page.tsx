import { createClient } from '@/lib/supabase/server'
import { requireFinanceAccess } from '@/lib/auth'
import { UserTable } from '@/components/users/user-table'
import type { Profile } from '@/types'

export default async function UsersPage() {
  const me = await requireFinanceAccess()
  const supabase = await createClient()

  const { data } = await supabase
    .from('profiles')
    .select('id, email, full_name, chinese_name, role, status, supervisor_id, created_at')
    .order('created_at', { ascending: true })

  const users = (data ?? []) as Pick<
    Profile,
    'id' | 'email' | 'full_name' | 'chinese_name' | 'role' | 'status' | 'supervisor_id' | 'created_at'
  >[]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">用户管理</h1>
        <p className="text-sm text-muted-foreground">
          财务和管理员可维护用户中文名；用户审核、角色、上级、密码及账号删除仍仅限管理员操作。
        </p>
      </div>

      <UserTable users={users} currentUserId={me.id} currentUserRole={me.role} />
    </div>
  )
}
