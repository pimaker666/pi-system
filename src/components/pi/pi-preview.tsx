'use client'

import dynamic from 'next/dynamic'
import { PiDocument } from './pi-document'
import type { CompanySettings, ProformaInvoiceWithItems } from '@/types'

// PDFViewer relies on browser APIs — never render it on the server.
const PDFViewer = dynamic(
  () => import('@react-pdf/renderer').then((m) => m.PDFViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        正在加载预览…
      </div>
    ),
  },
)

export function PiPreview({
  pi,
  company,
}: {
  pi: ProformaInvoiceWithItems
  company: CompanySettings | null
}) {
  return (
    <div className="h-[80vh] w-full overflow-hidden rounded-md border">
      <PDFViewer width="100%" height="100%" showToolbar>
        <PiDocument pi={pi} company={company} />
      </PDFViewer>
    </div>
  )
}
