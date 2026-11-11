import { cookies } from 'next/headers'
import { getFinancePageAccess, requireApproved } from '@/lib/auth'
import { getApprovalTodoCounts } from '@/lib/approvals-server'
import { createClient } from '@/lib/supabase/server'
import { displayProfileName } from '@/lib/utils'
import { Sidebar, type SidebarMode } from '@/components/layout/sidebar'
import { CommandPalette } from '@/components/layout/command-palette'
import { NavigationProgress } from '@/components/layout/navigation-progress'
import { LogoutButton } from '@/components/auth/logout-button'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const profile = await requireApproved()
  const cookieMode = (await cookies()).get('pi_sidebar_mode')?.value
  const sidebarMode: SidebarMode =
    cookieMode === 'expanded' || cookieMode === 'collapsed' ? cookieMode : 'auto'
  const isSalesperson = profile.role === 'sales' || profile.role === 'supervisor'
  const supabase = await createClient()
  // 与工作台「待我审批」同一口径：审批引擎 + 报销 + 请假（同一请求内只查一次）。
  const [financeAccess, commissionAttentionCount, approvalCounts] = await Promise.all([
    getFinancePageAccess(),
    isSalesperson
      ? supabase
        .from('finance_business_order_item_commission_clearances')
        .select('business_order_item_id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .then(({ count, error }) => {
          if (error) throw new Error(`提成提醒读取失败：${error.message}`)
          return count ?? 0
        })
      : Promise.resolve(0),
    getApprovalTodoCounts(),
  ])

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <NavigationProgress />
      <Sidebar
        role={profile.role}
        fullName={displayProfileName(profile)}
        financeAccess={financeAccess}
        commissionAttentionCount={commissionAttentionCount}
        approvalPendingCount={approvalCounts.total}
        mode={sidebarMode}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b bg-card px-4 md:px-6">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">工作空间</p>
            <p className="hidden text-xs text-muted-foreground sm:block">订单 · 产品 · 客户 · 财务</p>
          </div>
          <div className="flex items-center gap-2">
            <CommandPalette role={profile.role} financeAccess={financeAccess} />
            <LogoutButton />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  )
}
