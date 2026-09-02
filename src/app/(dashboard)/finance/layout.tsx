import { requireApproved } from '@/lib/auth'
import { FinanceNav } from '@/components/finance/finance-nav'

export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireApproved()

  return (
    <div>
      <FinanceNav role={profile.role} />
      {children}
    </div>
  )
}
