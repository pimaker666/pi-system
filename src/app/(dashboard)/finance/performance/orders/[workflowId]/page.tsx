import { redirect } from 'next/navigation'

export default function LegacyWorkflowDetailRedirectPage() {
  redirect('/finance/daily-orders/legacy')
}
