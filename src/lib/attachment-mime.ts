/**
 * 订单附件的类型口径：截图沿用 JPEG/PNG，另支持 PDF、Excel、Word、CSV。
 * 与 supabase/migrations/0157_order_attachment_documents.sql 的桶白名单、路径约束、
 * bind_business_order_attachment 校验保持一致，改一处必须同步其余。
 */
export const ORDER_ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
] as const

export type OrderAttachmentMimeType = (typeof ORDER_ATTACHMENT_MIME_TYPES)[number]

export const ORDER_ATTACHMENT_MIME_EXTENSIONS = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'application/pdf': ['pdf'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.ms-excel': ['xls'],
  'text/csv': ['csv'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/msword': ['doc'],
} as const satisfies Record<OrderAttachmentMimeType, readonly string[]>

export const ORDER_ATTACHMENT_EXTENSION_PATTERN = 'jpe?g|png|pdf|xlsx|xls|csv|docx|doc'

export const ORDER_ATTACHMENT_ACCEPT = ORDER_ATTACHMENT_MIME_TYPES.join(',')

/** 上传给 Storage 的对象路径后缀：每种类型取第一个常用后缀。 */
export function orderAttachmentExtension(mime: string): string | null {
  const extensions =
    ORDER_ATTACHMENT_MIME_EXTENSIONS[mime as OrderAttachmentMimeType]
  return extensions ? extensions[0] : null
}

export function isImageAttachmentMime(mime: string | null | undefined): boolean {
  return mime === 'image/jpeg' || mime === 'image/png'
}

export function isOrderAttachmentMime(mime: string | null | undefined): mime is OrderAttachmentMimeType {
  return (
    typeof mime === 'string' &&
    Object.prototype.hasOwnProperty.call(ORDER_ATTACHMENT_MIME_EXTENSIONS, mime)
  )
}

/**
 * 浏览器对部分 Office 文件给出的 MIME 可能为空或 application/octet-stream，
 * 此时按扩展名回退；仍无法识别则返回 null。
 */
export function resolveOrderAttachmentMime(file: File): OrderAttachmentMimeType | null {
  if (isOrderAttachmentMime(file.type)) return file.type
  const dot = file.name.lastIndexOf('.')
  if (dot < 0) return null
  const extension = file.name.slice(dot + 1).toLowerCase()
  for (const mime of ORDER_ATTACHMENT_MIME_TYPES) {
    if ((ORDER_ATTACHMENT_MIME_EXTENSIONS[mime] as readonly string[]).includes(extension)) {
      return mime
    }
  }
  return null
}

/** 展示用短标签（图片按截图处理）。 */
export function orderAttachmentKindLabel(mime: string | null | undefined): string {
  switch (mime) {
    case 'image/jpeg':
    case 'image/png':
      return '截图'
    case 'application/pdf':
      return 'PDF'
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.ms-excel':
      return 'Excel'
    case 'text/csv':
      return 'CSV'
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/msword':
      return 'Word'
    default:
      return '文件'
  }
}
