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
          公司账号继承时直接修改中文名：新记录使用新姓名，历史订单和业绩保持原姓名。员工离职请使用交接并停用；永久删除仅用于无业务数据的待审核误建账号。
        </p>
      </div>

      <UserTable users={users} currentUserId={me.id} currentUserRole={me.role} />
    </div>
  )
}
