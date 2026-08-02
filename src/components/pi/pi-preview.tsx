'use client'

/**
 * PDF preview via an <iframe> pointing at the server-rendered PDF route
 * (/api/pi/[id]/pdf?inline=1). This deliberately avoids running
 * @react-pdf/renderer in the browser — the in-browser PDFViewer proved
 * fragile (client-side exceptions on load) and pulled the heavy ESM-only
 * react-pdf bundle into the client. The server already renders the exact same
 * document reliably, so we reuse it for both preview and download.
 */
export function PiPreview({ id }: { id: string }) {
  return (
    <div className="h-[80vh] w-full overflow-hidden rounded-md border">
      <iframe
        src={`/api/pi/${id}/pdf?inline=1`}
        title="PI PDF 预览"
        className="h-full w-full"
      />
    </div>
  )
}
