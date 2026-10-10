'use client'

import { useRef, useState } from 'react'
import type { DragEvent } from 'react'

export const MAX_IMAGE_SIZE = 20 * 1024 * 1024

/** 全站统一标准：图片上传支持拖放，单张不超过 20MB。 */
export function validateImageFile(file: File, allowedTypes?: readonly string[]): string | null {
  const allowed = allowedTypes ?? ['image/jpeg', 'image/png', 'image/webp']
  if (!allowed.includes(file.type)) return '不支持的图片格式'
  if (file.size > MAX_IMAGE_SIZE) return '图片不能超过 20MB'
  return null
}

interface UseFileDropOptions {
  onFile: (file: File) => void
  disabled?: boolean
}

/** 返回 dragging 高亮标记与一组拖放事件 props，挂到任意容器上即可接收拖入的文件。 */
export function useFileDrop({ onFile, disabled = false }: UseFileDropOptions) {
  const [dragging, setDragging] = useState(false)
  const depthRef = useRef(0)

  function onDragEnter(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    if (disabled) return
    depthRef.current += 1
    setDragging(true)
  }

  function onDragOver(event: DragEvent<HTMLElement>) {
    event.preventDefault()
  }

  function onDragLeave() {
    depthRef.current -= 1
    if (depthRef.current <= 0) {
      depthRef.current = 0
      setDragging(false)
    }
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    depthRef.current = 0
    setDragging(false)
    if (disabled) return
    const file = event.dataTransfer.files?.[0]
    if (file) onFile(file)
  }

  return {
    dragging,
    dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
