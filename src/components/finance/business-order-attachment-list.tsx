'use client'

import { useState } from 'react'
import {
  DocumentAttachmentRow,
  formatFileSize,
  ImageAttachmentRow,
} from '@/components/shared/image-attachment-items'
import { renameBusinessOrderAttachment } from '@/lib/actions/business-orders'
import { isImageAttachmentMime } from '@/lib/attachment-mime'
import type { BusinessOrderAttachment } from '@/types'

interface BusinessOrderAttachmentListProps {
  items: Array<{
    attachment: BusinessOrderAttachment
    url: string | null
    /** 缩略图签名链接；缺省时缩略图退回原图。 */
    thumbUrl?: string | null
  }>
  canRename: boolean
}

/** 订单详情附件列表：图片缩略图预览，文档按类型展示并可打开；名称可改（受编辑状态与角色限制）。 */
export function BusinessOrderAttachmentList({ items, canRename }: BusinessOrderAttachmentListProps) {
  const [renamed, setRenamed] = useState<Record<string, string>>({})

  async function handleRename(id: string, name: string) {
    const result = await renameBusinessOrderAttachment(id, name)
    if (result.ok) {
      setRenamed((current) => ({
        ...current,
        [id]: result.attachment?.original_name ?? name,
      }))
    }
    return { ok: result.ok, error: result.error }
  }

  return (
    <div className="space-y-3">
      {items.map(({ attachment, url, thumbUrl }, index) =>
        url ? (
          isImageAttachmentMime(attachment.mime_type) ? (
            <ImageAttachmentRow
              key={attachment.id}
              src={url}
              thumbSrc={thumbUrl}
              rawSrc
              name={renamed[attachment.id] ?? attachment.original_name}
              uploadedAt={attachment.created_at}
              onRename={canRename ? (name) => handleRename(attachment.id, name) : undefined}
            />
          ) : (
            <DocumentAttachmentRow
              key={attachment.id}
              mimeType={attachment.mime_type}
              name={renamed[attachment.id] ?? attachment.original_name}
              sizeLabel={formatFileSize(attachment.size_bytes)}
              uploadedAt={attachment.created_at}
              href={url}
              onRename={canRename ? (name) => handleRename(attachment.id, name) : undefined}
            />
          )
        ) : (
          <div key={attachment.id} className="text-destructive">
            附件 {index + 1} 链接生成失败，请稍后重试
          </div>
        ),
      )}
    </div>
  )
}
