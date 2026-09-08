import { redirect } from 'next/navigation'

export default function NewBusinessOrderRedirectPage() {
  redirect('/finance/daily-orders/new')
}
