import { hasFinanceViewFor, requireApproved } from '@/lib/auth'
import { displayProfileName } from '@/lib/utils'
import { Sidebar } from '@/components/layout/sidebar'
import { LogoutButton } from '@/components/auth/logout-button'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const profile = await requireApproved()
  const canViewFinance = await hasFinanceViewFor(profile)

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar
        role={profile.role}
        fullName={displayProfileName(profile)}
        canViewFinance={canViewFinance}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b bg-card px-4 md:px-6">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">工作空间</p>
            <p className="hidden text-xs text-muted-foreground sm:block">订单 · 产品 · 客户 · 财务</p>
          </div>
          <LogoutButton />
        </header>
        <main className="min-h-0 flex-1 overflow-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  )
}
