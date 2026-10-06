import { requireAdmin } from '@/lib/auth'
import { PermissionManagementOverview } from '@/components/users/permission-management-overview'
import { PermissionPageNav } from '@/components/users/permission-page-nav'
import { getPermissionTemplates } from '@/lib/actions/permissions'

export default async function PermissionManagementPage() {
  await requireAdmin()
  const templates = await getPermissionTemplates()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">权限管理</h1>
        <p className="text-sm text-muted-foreground">统一查看角色权限、数据范围、敏感字段和订单审核规则。</p>
      </div>
      <PermissionPageNav active="/users/permissions" />
      <PermissionManagementOverview templates={templates} />
    </div>
  )
}
