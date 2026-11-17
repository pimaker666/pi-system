import type { Metadata } from 'next'
import './quote.css'
import { requireProfile } from '@/lib/auth'
import { QuoteClient } from './quote-client'

export const metadata: Metadata = {
  title: '报价计算',
}

export default async function QuotePage() {
  const profile = await requireProfile()
  return <QuoteClient isAdmin={profile.role === 'admin'} />
}
