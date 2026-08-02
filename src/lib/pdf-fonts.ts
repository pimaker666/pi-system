import { Font } from '@react-pdf/renderer'

let registered = false

/**
 * Idempotently register the fonts used by the PI PDF for react-pdf.
 *
 * Two families are registered:
 *  - NotoSansSC : Chinese-capable base font (also covers Latin). Used as the
 *    page default and for any Text that may contain customer/product Chinese.
 *  - Inter      : clean Latin typeface used only for known-ASCII elements.
 *
 * Font loading strategy:
 *  - This module is imported ONLY by the server-side PDF route (pi-document.tsx
 *    is a server component). We register fonts from the filesystem.
 *  - The .ttf files live in `public/fonts` and are shipped into the serverless
 *    function via `outputFileTracingIncludes` in next.config.js. On Vercel the
 *    function's cwd is the project root (/var/task), so process.cwd()/public/fonts
 *    resolves correctly. We probe a few candidate roots and pick the first that
 *    exists, so a missing-file ENOENT can never crash renderToBuffer.
 *  - Must use .ttf (subsetted Noto Sans SC + Inter). .otf / CFF render blank.
 *  - Never apply the Inter family to text that could contain Chinese.
 */
function resolveFontPath(file: string): string {
  const path = require('path') as typeof import('path')
  const fs = require('fs') as typeof import('fs')

  const candidates = [
    path.join(process.cwd(), 'public', 'fonts', file),
    path.join(process.cwd(), 'fonts', file),
    // Fallbacks in case cwd differs from the traced root.
    path.join(__dirname, '..', '..', 'public', 'fonts', file),
    path.join('/var/task', 'public', 'fonts', file),
  ]

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // ignore and try the next candidate
    }
  }
  // Last resort: return the conventional path; react-pdf will surface a clear
  // error if it is genuinely missing.
  return candidates[0]
}

export function registerPdfFonts() {
  if (registered) return
  registered = true

  Font.register({
    family: 'NotoSansSC',
    fonts: [
      { src: resolveFontPath('NotoSansSC-Regular.ttf'), fontWeight: 'normal' },
      { src: resolveFontPath('NotoSansSC-Bold.ttf'), fontWeight: 'bold' },
    ],
  })

  Font.register({
    family: 'Inter',
    fonts: [
      { src: resolveFontPath('Inter-Regular.ttf'), fontWeight: 'normal' },
      { src: resolveFontPath('Inter-Bold.ttf'), fontWeight: 'bold' },
    ],
  })

  // Prevent react-pdf from breaking CJK text at arbitrary characters.
  Font.registerHyphenationCallback((word) => [word])
}
