// 浏览器端按需加载本地打包的 pdfjs（public/vendor/pdfjs），对账单文件不上传服务器。

interface PdfTextItem {
  str?: string
  transform: number[]
}

interface PdfTextContent {
  items: PdfTextItem[]
}

interface PdfPage {
  getViewport(params: { scale: number }): { transform: number[] }
  getTextContent(): Promise<PdfTextContent>
}

interface PdfDocument {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPage>
  destroy(): Promise<void>
}

interface PdfjsLib {
  GlobalWorkerOptions: { workerSrc: string }
  Util: { transform(first: number[], second: number[]): number[] }
  getDocument(params: {
    data: Uint8Array
    cMapUrl?: string
    cMapPacked?: boolean
    isEvalSupported?: boolean
  }): { promise: Promise<PdfDocument> }
}

type PdfjsWindow = Window & { pdfjsLib?: PdfjsLib }

let loader: Promise<PdfjsLib> | null = null

function loadPdfjs(): Promise<PdfjsLib> {
  const existing = (window as PdfjsWindow).pdfjsLib
  if (existing) return Promise.resolve(existing)
  if (loader) return loader
  loader = new Promise<PdfjsLib>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/vendor/pdfjs/pdf.min.js'
    script.async = true
    script.onload = () => {
      const lib = (window as PdfjsWindow).pdfjsLib
      if (!lib) {
        loader = null
        reject(new Error('PDF 解析组件加载失败'))
        return
      }
      lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js'
      resolve(lib)
    }
    script.onerror = () => {
      loader = null
      reject(new Error('PDF 解析组件加载失败，请刷新页面重试'))
    }
    document.head.appendChild(script)
  })
  return loader
}

const LINE_TOLERANCE = 2.5

// 对账单可能是旋转页面，先映射到视口坐标，再按行（y）和列（x）还原文本。
async function pageToText(page: PdfPage, lib: PdfjsLib): Promise<string> {
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const lines: Array<{ y: number; items: Array<{ x: number; str: string }> }> = []
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue
    const transformed = lib.Util.transform(viewport.transform, item.transform)
    const x = transformed[4]
    const y = transformed[5]
    let line = lines.find((candidate) => Math.abs(candidate.y - y) < LINE_TOLERANCE)
    if (!line) {
      line = { y, items: [] }
      lines.push(line)
    }
    line.items.push({ x, str: item.str })
  }
  return lines
    .sort((a, b) => a.y - b.y)
    .map((line) =>
      line.items
        .sort((a, b) => a.x - b.x)
        .map((item) => item.str)
        .join(''),
    )
    .join('\n')
}

export async function extractPdfText(file: File): Promise<string> {
  const lib = await loadPdfjs()
  const data = new Uint8Array(await file.arrayBuffer())
  const documentProxy = await lib.getDocument({
    data,
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    isEvalSupported: false,
  }).promise
  const pages: string[] = []
  try {
    for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
      pages.push(await pageToText(await documentProxy.getPage(pageNumber), lib))
    }
  } finally {
    await documentProxy.destroy()
  }
  const text = pages.join('\n')
  if (!text.trim()) {
    throw new Error('PDF 中没有可提取的文字，可能是扫描件；请改用 Excel/CSV 文件，或全选复制对账单文字后粘贴导入')
  }
  return text
}
