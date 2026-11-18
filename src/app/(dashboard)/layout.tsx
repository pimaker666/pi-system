import { requireApproved } from '@/lib/auth'
import { displayProfileName } from '@/lib/utils'
import { Sidebar } from '@/components/layout/sidebar'
import { MobileNav } from '@/components/layout/mobile-nav'
import { LogoutButton } from '@/components/auth/logout-button'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const profile = await requireApproved()

  return (
    <div className="app-shell flex h-screen overflow-hidden">
      <Sidebar role={profile.role} fullName={displayProfileName(profile)} />
      <div className="app-column flex flex-1 flex-col overflow-hidden">
        <header className="print-chrome flex h-16 items-center justify-between gap-2 border-b px-4 sm:px-6">
          <MobileNav role={profile.role} fullName={displayProfileName(profile)} />
          <span className="flex-1" />
          <LogoutButton />
        </header>
        <main className="app-main flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  )
}
