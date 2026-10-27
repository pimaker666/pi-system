'use client'

import { useEffect, useState } from 'react'
import { Check, Pencil, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ImagePreview } from '@/components/ui/image-preview'
import { cn, formatDate } from '@/lib/utils'

export interface RenameResult {
  ok: boolean
  error?: string
}

/** 上传时间统一按上海时区显示到分钟；历史数据没有时间时明确标「未记录」。 */
export function formatUploadedAt(value?: string | null): string {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未记录'
  return formatDate(date, true)
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface EditableImageNameProps {
  value: string | null | undefined
  fallback: string
  maxLength?: number
  disabled?: boolean
  onRename?: (name: string) => Promise<RenameResult>
  className?: string
}

/** 图片名称：默认只读展示，传入 onRename 时出现铅笔按钮，回车或勾选保存。 */
export function EditableImageName({
  value,
  fallback,
  maxLength = 255,
  disabled = false,
  onRename,
  className,
}: EditableImageNameProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(value ?? '')
  }, [value, editing])

  async function commit() {
    if (!onRename) {
      setEditing(false)
      return
    }
    const next = draft.trim()
    if (!next) {
      toast.error('图片名称不能为空')
      return
    }
    if (next === (value ?? '').trim()) {
      setEditing(false)
      return
    }
    setSaving(true)
    const result = await onRename(next)
    setSaving(false)
    if (!result.ok) {
      toast.error(result.error ?? '修改图片名称失败')
      return
    }
    setEditing(false)
  }

  if (!editing) {
    return (
      <span className={cn('flex min-w-0 items-center gap-1', className)}>
        <span className="truncate">{value?.trim() || fallback}</span>
        {onRename && (
          <button
            type="button"
            aria-label="修改图片名称"
            title="修改图片名称"
            disabled={disabled}
            onClick={() => setEditing(true)}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </span>
    )
  }

  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      <Input
        autoFocus
        value={draft}
        maxLength={maxLength}
        disabled={saving}
        className="h-7 text-sm"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setEditing(false)
          }
        }}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        aria-label="保存名称"
        disabled={saving}
        onClick={() => void commit()}
      >
        <Check className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        aria-label="取消修改"
        disabled={saving}
        onClick={() => setEditing(false)}
      >
        <X className="h-4 w-4" />
      </Button>
    </span>
  )
}

interface ImageAttachmentRowProps {
  src?: string | null
  name?: string | null
  uploadedAt?: string | null
  /** signed URL 需传 true，公开 URL 交给 toImageSrc 改写。 */
  rawSrc?: boolean
  disabled?: boolean
  onRename?: (name: string) => Promise<RenameResult>
  onRemove?: () => void
  removeLabel?: string
  removeDisabled?: boolean
}

/** 已上传图片：缩略图（点击放大）+ 可改名称 + 上传时间 + 删除。 */
export function ImageAttachmentRow({
  src,
  name,
  uploadedAt,
  rawSrc = false,
  disabled = false,
  onRename,
  onRemove,
  removeLabel = '删除图片',
  removeDisabled = false,
}: ImageAttachmentRowProps) {
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
      <ImagePreview
        src={src}
        alt={name?.trim() || '图片'}
        size="h-16 w-16"
        sizes="64px"
        rawSrc={rawSrc}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <EditableImageName
          value={name}
          fallback="未命名图片"
          disabled={disabled}
          onRename={onRename}
          className="font-medium"
        />
        <div className="text-xs text-muted-foreground">
          上传时间：{formatUploadedAt(uploadedAt)}
        </div>
      </div>
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={removeLabel}
          title={removeLabel}
          disabled={disabled || removeDisabled}
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}

interface PendingImageRowProps {
  file: File
  name: string
  disabled?: boolean
  onRename: (name: string) => void
  onRemove: () => void
}

/** 待上传图片：本地缩略图 + 可改名称 + 文件大小，上传时使用改后的名称。 */
export function PendingImageRow({
  file,
  name,
  disabled = false,
  onRename,
  onRemove,
}: PendingImageRowProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed px-3 py-2 text-sm">
      <button
        type="button"
        aria-label="查看大图"
        title="查看大图"
        onClick={() => previewUrl && setOpen(true)}
        className="h-16 w-16 shrink-0 overflow-hidden rounded border bg-muted"
      >
        {previewUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt={name || file.name} className="h-full w-full object-cover" />
        )}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90vh] w-auto max-w-[90vw] items-center justify-center border-none bg-black/90 p-2">
          <DialogTitle className="sr-only">{name || file.name}</DialogTitle>
          {previewUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt={name || file.name} className="max-h-[85vh] max-w-full rounded object-contain" />
          )}
        </DialogContent>
      </Dialog>
      <div className="min-w-0 flex-1 space-y-1">
        <EditableImageName
          value={name}
          fallback={file.name}
          disabled={disabled}
          onRename={async (next) => {
            onRename(next)
            return { ok: true }
          }}
          className="font-medium"
        />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            待上传
          </Badge>
          <span>{formatFileSize(file.size)}</span>
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="移除待上传图片"
        title="移除待上传图片"
        disabled={disabled}
        onClick={onRemove}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  )
}

interface ImageAttachmentTileProps {
  src?: string | null
  name?: string | null
  uploadedAt?: string | null
  disabled?: boolean
  onRename?: (name: string) => Promise<RenameResult>
  onRemove?: () => void
  removeLabel?: string
  removeDisabled?: boolean
}

/** 图格式场景（如客户 Logo）：方形缩略图 + 名称 + 上传时间。 */
export function ImageAttachmentTile({
  src,
  name,
  uploadedAt,
  disabled = false,
  onRename,
  onRemove,
  removeLabel = '删除图片',
  removeDisabled = false,
}: ImageAttachmentTileProps) {
  return (
    <div className="rounded-md border bg-muted/20 p-2">
      <div className="relative">
        <ImagePreview
          src={src}
          alt={name?.trim() || '图片'}
          size="aspect-square w-full"
          sizes="160px"
        />
        {onRemove && (
          <Button
            type="button"
            variant="destructive"
            size="icon"
            className="absolute right-1 top-1 h-7 w-7"
            aria-label={removeLabel}
            title={removeLabel}
            disabled={disabled || removeDisabled}
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div className="mt-2 space-y-0.5">
        <EditableImageName
          value={name}
          fallback="未命名图片"
          disabled={disabled}
          onRename={onRename}
          className="text-xs font-medium"
        />
        <div className="text-[11px] text-muted-foreground">
          上传时间：{formatUploadedAt(uploadedAt)}
        </div>
      </div>
    </div>
  )
}

interface ImageAttachmentBlockProps {
  src?: string | null
  name?: string | null
  uploadedAt?: string | null
  disabled?: boolean
  onRename?: (name: string) => Promise<RenameResult>
}

/** 弹窗内查看大图：名称与上传时间置于图片上方。 */
export function ImageAttachmentBlock({
  src,
  name,
  uploadedAt,
  disabled = false,
  onRename,
}: ImageAttachmentBlockProps) {
  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="flex items-start justify-between gap-3 text-sm">
        <EditableImageName
          value={name}
          fallback="未命名图片"
          disabled={disabled}
          onRename={onRename}
          className="font-medium"
        />
        <span className="shrink-0 text-xs text-muted-foreground">
          上传时间：{formatUploadedAt(uploadedAt)}
        </span>
      </div>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name?.trim() || '图片'} className="w-full rounded-md border" />
      ) : (
        <div className="text-sm text-destructive">图片链接生成失败，请稍后重试</div>
      )}
    </div>
  )
}
