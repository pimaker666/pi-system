import { createClient } from '@/lib/supabase/server'
import { requireFinanceAccess } from '@/lib/auth'
import { UserTable } from '@/components/users/user-table'
import { PermissionPageNav } from '@/components/users/permission-page-nav'
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
        <h1 className="text-2xl font-semibold">账号管理</h1>
        <p className="text-sm text-muted-foreground">
          管理账号状态、基础角色、组织上级和离职交接。账号例外权限与审批记录可从下方导航进入。
        </p>
      </div>

      <PermissionPageNav active="/users" showConfiguration={me.role === 'admin'} />
      <UserTable users={users} currentUserId={me.id} currentUserRole={me.role} />
    </div>
  )
}
