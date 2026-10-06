import Link from 'next/link'
import { ArrowLeft, LockKeyhole } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { AccountPermissionOverrideForm } from './account-permission-override-form'
import type { Profile, ProfilePermissionOverride, ResolvedProfilePermission } from '@/types'

const roleLabels = { admin: '管理员', finance: '财务', supervisor: '业务主管', sales: '业务员' } as const
const dataScopeLabels = { self: '仅本人', self_and_subordinates: '本人及下级', team: '指定团队', all: '全部数据' } as const
const permissionRows = [
  ['查看订单', 'orders.view'],
  ['创建订单', 'orders.create'],
  ['编辑订单', 'orders.edit'],
  ['作废订单', 'orders.void'],
  ['发货登记', 'orders.ship'],
  ['登记订单转账', 'orders.record_transfer'],
  ['审核订单', 'orders.approve'],
  ['导出订单', 'orders.export'],
] as const
const sensitiveFields = [
  ['财务编号', 'financial_number'],
  ['产品名称', 'product_name'],
  ['成本', 'cost'],
  ['毛利', 'profit'],
  ['汇率', 'exchange_rate'],
] as const

function displayName(profile: Profile) {
  return profile.chinese_name?.trim() || profile.full_name?.trim() || profile.email
}

function templatePermission(permissions: Record<string, unknown>, path: string) {
  return path.split('.').reduce<unknown>((value, key) => (
    value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  ), permissions) === true
}

function effectivePermission(resolved: ResolvedProfilePermission, path: string) {
  if (resolved.denied_permissions.includes(path)) return false
  if (resolved.allowed_permissions.includes(path)) return true
  return templatePermission(resolved.template_permissions, path)
}

export function AccountPermissionDetail({
  profile,
  override,
  resolved,
}: {
  profile: Profile
  override: ProfilePermissionOverride | null
  resolved: ResolvedProfilePermission
}) {
  const statusLabel = profile.status === 'approved' ? '启用中' : profile.status === 'disabled' ? '已停用' : '待审核'
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon"><Link href="/users" aria-label="返回账号管理"><ArrowLeft className="h-4 w-4" /></Link></Button>
        <div>
          <h1 className="text-2xl font-semibold">{displayName(profile)}的权限</h1>
          <p className="text-sm text-muted-foreground">查看角色模板、账号例外与最终生效的权限。</p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[280px_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>{displayName(profile)}</CardTitle><CardDescription>{profile.email}</CardDescription></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">账号状态</span><Badge variant={profile.status === 'approved' ? 'outline' : 'secondary'}>{statusLabel}</Badge></div>
              <div className="flex justify-between"><span className="text-muted-foreground">基础角色</span><Badge>{roleLabels[profile.role]}</Badge></div>
              <div className="flex justify-between"><span className="text-muted-foreground">数据范围</span><span>{dataScopeLabels[resolved.data_scope]}</span></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">权限概览</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between"><span>角色继承</span><span className="font-medium">{roleLabels[profile.role]}模板</span></div>
              <div className="flex justify-between"><span>额外授予</span><span className="font-medium">{resolved.allowed_permissions.length} 项</span></div>
              <div className="flex justify-between"><span>单独禁止</span><span className="font-medium">{resolved.denied_permissions.length} 项</span></div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="border-primary/30 bg-primary/5"><CardContent className="flex gap-3 p-4 text-sm"><LockKeyhole className="h-4 w-4 shrink-0 text-primary" /><p>账号例外优先于“{roleLabels[profile.role]}”角色模板。所有保存操作都会记录到权限审计日志。</p></CardContent></Card>
          <Card>
            <CardHeader><CardTitle>订单操作权限</CardTitle><CardDescription>最终权限按角色模板、额外授予和单独禁止依次决议。</CardDescription></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table className="min-w-[680px]">
                <TableHeader><TableRow><TableHead>权限项</TableHead><TableHead>角色默认</TableHead><TableHead>账号例外</TableHead><TableHead>最终权限</TableHead></TableRow></TableHeader>
                <TableBody>{permissionRows.map(([name, path]) => {
                  const inherited = templatePermission(resolved.template_permissions, path)
                  const exception = resolved.denied_permissions.includes(path) ? '禁止' : resolved.allowed_permissions.includes(path) ? '允许' : '继承'
                  const finalPermission = effectivePermission(resolved, path)
                  return <TableRow key={path}><TableCell className="font-medium">{name}</TableCell><TableCell>{inherited ? '允许' : '不允许'}</TableCell><TableCell><Badge variant={exception === '继承' ? 'secondary' : exception === '允许' ? 'outline' : 'destructive'}>{exception}</Badge></TableCell><TableCell><Badge variant={finalPermission ? 'outline' : 'secondary'}>{finalPermission ? '允许' : '不允许'}</Badge></TableCell></TableRow>
                })}</TableBody>
              </Table>
            </CardContent>
          </Card>
          <div className="grid gap-6 md:grid-cols-2">
            <Card><CardHeader><CardTitle className="text-base">数据范围</CardTitle></CardHeader><CardContent className="text-sm"><p className="font-medium">{dataScopeLabels[resolved.data_scope]}</p><p className="mt-1 text-muted-foreground">当前结果已包含账号例外的数据范围设置。</p></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base">敏感字段</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">{sensitiveFields.map(([label, key]) => <div key={key} className="flex justify-between"><span>{label}</span><Badge variant={resolved.sensitive_fields[key] === true ? 'outline' : 'secondary'}>{resolved.sensitive_fields[key] === true ? '可见' : '隐藏'}</Badge></div>)}</CardContent></Card>
          </div>
          <AccountPermissionOverrideForm profileId={profile.id} initial={override} />
        </div>
      </div>
    </div>
  )
}
