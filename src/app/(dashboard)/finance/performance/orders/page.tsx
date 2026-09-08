import { redirect } from 'next/navigation'

export default function LegacyWorkflowRedirectPage() {
  redirect('/finance/daily-orders/legacy')
}
