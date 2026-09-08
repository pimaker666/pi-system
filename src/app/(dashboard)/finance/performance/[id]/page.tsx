import { redirect } from 'next/navigation'

export default async function BusinessOrderDetailRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/finance/daily-orders/${id}`)
}
