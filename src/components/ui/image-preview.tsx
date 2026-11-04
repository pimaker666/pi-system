'use client'

import * as React from 'react'
import Image from 'next/image'
import { ZoomIn } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { toImageSrc } from '@/lib/supabase/image'

/**
 * 缩略图改走 Supabase 图片变换（imgproxy）。产品图平均 600KB 以上，直接拉原图
 * 在局域网感觉不到，但走公网隧道时一屏几十张就是几十 MB；96px 缩略图约 12KB。
 * 仅对公开对象生效，签名 URL（rawSrc）保持原样。
 */
function toThumbSrc(src: string | null | undefined, sizes: string) {
  const base = toImageSrc(src)
  const marker = '/storage/v1/object/public/'
  const index = base.indexOf(marker)
  if (index === -1) return base
  const cssPx = Number(/^(\d+)px/.exec(sizes)?.[1] ?? 40)
  const width = Math.min(Math.max(cssPx * 2, 32), 256)
  const tail = base.slice(index + marker.length)
  return `/supabase/storage/v1/render/image/public/${tail}${
    tail.includes('?') ? '&' : '?'
  }width=${width}&height=${width}&resize=cover&quality=75`
}

interface ImagePreviewProps {
  src: string | null | undefined
  /** 独立的小尺寸缩略图地址（私有桶签名变换），缺省时按 src 推导。 */
  thumbSrc?: string | null
  alt?: string
  /** Container size class, e.g. "h-10 w-10" or "h-12 w-12" */
  size?: string
  /** sizes attribute for next/image optimization */
  sizes?: string
  /** Fallback icon when no image */
  fallback?: React.ReactNode
  /** Additional className for the container */
  className?: string
  /** Use src as-is without toImageSrc transformation (for signed URLs). */
  rawSrc?: boolean
}

/**
 * Product image thumbnail with hover zoom icon and click-to-preview lightbox.
 * Drop-in replacement for the existing image containers in product table & selector.
 */
export function ImagePreview({
  src,
  thumbSrc: thumbSrcProp,
  alt = '产品图片',
  size = 'h-10 w-10',
  sizes = '40px',
  fallback,
  className,
  rawSrc = false,
}: ImagePreviewProps) {
  const [open, setOpen] = React.useState(false)
  const imgSrc = rawSrc ? (src ?? '') : toImageSrc(src)
  const [thumbFailed, setThumbFailed] = React.useState(false)

  React.useEffect(() => {
    setThumbFailed(false)
  }, [src])

  const thumbSrc = thumbFailed
    ? imgSrc
    : thumbSrcProp ?? (rawSrc ? imgSrc : toThumbSrc(src, sizes))

  return (
    <>
      <div
        className={`group/preview relative ${size} shrink-0 overflow-hidden rounded border bg-muted ${className || ''}`}
      >
        {imgSrc ? (
          <>
            <Image
              src={thumbSrc}
              alt={alt}
              fill
              className="object-cover"
              sizes={sizes}
              onError={() => setThumbFailed(true)}
            />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setOpen(true)
              }}
              className="absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 transition-opacity group-hover/preview:opacity-100"
              aria-label="查看大图"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
          </>
        ) : (
          fallback || (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
          )
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] w-auto p-2 flex items-center justify-center bg-black/90 border-none">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          {imgSrc && (
            <div className="relative w-full h-full max-w-[85vw] max-h-[85vh] flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imgSrc}
                alt={alt}
                className="max-w-full max-h-[85vh] object-contain rounded"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
