import { hasFinanceViewFor, requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { displayProfileName } from '@/lib/utils'
import { Sidebar } from '@/components/layout/sidebar'
import { CommandPalette } from '@/components/layout/command-palette'
import { LogoutButton } from '@/components/auth/logout-button'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const profile = await requireApproved()
  const isSalesperson = profile.role === 'sales' || profile.role === 'supervisor'
  const supabase = isSalesperson ? await createClient() : null
  const [canViewFinance, commissionAttentionCount] = await Promise.all([
    hasFinanceViewFor(profile),
    supabase
      ? supabase
        .from('finance_business_order_item_commission_clearances')
        .select('business_order_item_id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .then(({ count, error }) => {
          if (error) throw new Error(`提成提醒读取失败：${error.message}`)
          return count ?? 0
        })
      : Promise.resolve(0),
  ])

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar
        role={profile.role}
        fullName={displayProfileName(profile)}
        canViewFinance={canViewFinance}
        commissionAttentionCount={commissionAttentionCount}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b bg-card px-4 md:px-6">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">工作空间</p>
            <p className="hidden text-xs text-muted-foreground sm:block">订单 · 产品 · 客户 · 财务</p>
          </div>
          <div className="flex items-center gap-2">
            <CommandPalette role={profile.role} canViewFinance={canViewFinance} />
            <LogoutButton />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  )
}
