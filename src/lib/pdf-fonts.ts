import { Font } from '@react-pdf/renderer'

let registered = false

/**
 * Idempotently register the fonts used by the PI PDF for react-pdf.
 *
 * Two families are registered:
 *  - NotoSansSC : Chinese-capable base font (also covers Latin). Used as the
 *    page default and for any Text that may contain customer/product Chinese.
 *  - Inter      : clean Latin typeface used only for known-ASCII elements
 *    (document title, section labels, table headers, numeric amounts).
 *
 * IMPORTANT:
 *  - Must use .ttf (subsetted Noto Sans SC + Inter). .otf / CFF fonts render blank.
 *  - On the server we resolve an absolute filesystem path; in the browser
 *    (PDFViewer preview) we load from the public URL.
 *  - Never apply the Inter family to text that could contain Chinese — Inter
 *    has no CJK glyphs and those characters would render blank.
 */
export function registerPdfFonts() {
  if (registered) return
  registered = true

  const isServer = typeof window === 'undefined'

  const resolve = (file: string) => {
    if (isServer) {
      // Resolved relative to the project root at runtime.
      // next.config.js `outputFileTracingIncludes` ships these files with the build.
      const path = require('path') as typeof import('path')
      return path.join(process.cwd(), 'public', 'fonts', file)
    }
    return `/fonts/${file}`
  }

  Font.register({
    family: 'NotoSansSC',
    fonts: [
      { src: resolve('NotoSansSC-Regular.ttf'), fontWeight: 'normal' },
      { src: resolve('NotoSansSC-Bold.ttf'), fontWeight: 'bold' },
    ],
  })

  Font.register({
    family: 'Inter',
    fonts: [
      { src: resolve('Inter-Regular.ttf'), fontWeight: 'normal' },
      { src: resolve('Inter-Bold.ttf'), fontWeight: 'bold' },
    ],
  })

  // Prevent react-pdf from breaking CJK text at arbitrary characters.
  Font.registerHyphenationCallback((word) => [word])
}
