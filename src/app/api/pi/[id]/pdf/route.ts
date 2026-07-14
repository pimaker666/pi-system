import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { createElement } from 'react'
import { createClient } from '@/lib/supabase/server'
import { PiDocument } from '@/components/pi/pi-document'
import type { CompanySettings, ProformaInvoiceWithItems } from '@/types'

export const dynamic = 'force-dynamic'

/**
 * On-demand PDF rendering. RLS on the session ensures only the owner (or an
 * admin) can fetch a given PI. Streams the freshly rendered document so the
 * output always reflects the latest data / void state.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const [{ data: piData, error }, { data: companyData }] = await Promise.all([
    supabase.from('proforma_invoices').select('*, pi_items(*)').eq('id', id).single(),
    supabase.from('company_settings').select('*').eq('id', 1).maybeSingle(),
  ])

  if (error || !piData) {
    return new NextResponse('Not found', { status: 404 })
  }

  const pi = piData as ProformaInvoiceWithItems
  const company = (companyData ?? null) as CompanySettings | null

  const buffer = await renderToBuffer(
    // react-pdf's renderToBuffer types insist on a Document element; our
    // PiDocument renders a <Document> at runtime, so the cast is safe.
    createElement(PiDocument, { pi, company }) as never,
  )

  // Buffer isn't a valid BodyInit under these lib types; hand over a Uint8Array.
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${pi.pi_number}.pdf"`,
      'Cache-Control': 'no-store',
    },
  })
}
