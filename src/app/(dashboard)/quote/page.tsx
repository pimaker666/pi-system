import type { Metadata } from 'next'
import './quote.css'
import { QuoteClient } from './quote-client'

export const metadata: Metadata = {
  title: '报价计算',
}

export default function QuotePage() {
  return <QuoteClient />
}
