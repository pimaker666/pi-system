import { redirect } from 'next/navigation'

export default async function EditBusinessOrderRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/finance/daily-orders/${id}/edit`)
}
