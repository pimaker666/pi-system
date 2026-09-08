import { redirect } from 'next/navigation'

export default function LegacyTeamDailyOrdersRedirectPage() {
  redirect('/finance/daily-orders/legacy')
}
