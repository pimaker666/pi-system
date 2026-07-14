import { requireProfile } from '@/lib/auth'
import { Sidebar } from '@/components/layout/sidebar'
import { LogoutButton } from '@/components/auth/logout-button'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const profile = await requireProfile()

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar role={profile.role} fullName={profile.full_name} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-16 items-center justify-end border-b px-6">
          <LogoutButton />
        </header>
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  )
}
