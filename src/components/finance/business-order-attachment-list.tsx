'use client'

import { useState } from 'react'
import { ImageAttachmentRow } from '@/components/shared/image-attachment-items'
import { renameBusinessOrderAttachment } from '@/lib/actions/business-orders'
import type { BusinessOrderAttachment } from '@/types'

interface BusinessOrderAttachmentListProps {
  items: Array<{ attachment: BusinessOrderAttachment; url: string | null }>
  canRename: boolean
}

/** 订单详情里的截图列表：缩略图预览、名称可改（受订单编辑状态与角色限制）、显示上传时间。 */
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
      {items.map(({ attachment, url }, index) =>
        url ? (
          <ImageAttachmentRow
            key={attachment.id}
            src={url}
            rawSrc
            name={renamed[attachment.id] ?? attachment.original_name}
            uploadedAt={attachment.created_at}
            onRename={canRename ? (name) => handleRename(attachment.id, name) : undefined}
          />
        ) : (
          <div key={attachment.id} className="text-destructive">
            截图 {index + 1} 链接生成失败，请稍后重试
          </div>
        ),
      )}
    </div>
  )
}
