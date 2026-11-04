import { PageSkeleton } from '@/components/shared/page-skeleton'

export default function Loading() {
  return <PageSkeleton variant="cards" rows={6} columns={5} />
}
