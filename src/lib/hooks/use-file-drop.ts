'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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

// ---------- 粘贴上传（全站统一标准：Ctrl/Cmd+V 直接入队） ----------

interface PasteZone {
  root: HTMLElement | null
  deliver: (files: File[]) => void
}

const pasteZones = new Set<PasteZone>()
let lastHoveredZone: PasteZone | null = null
let pasteListenersInstalled = false

function extractPastedImages(dataTransfer: DataTransfer | null): File[] {
  return Array.from(dataTransfer?.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

function installPasteListeners() {
  if (pasteListenersInstalled || typeof window === 'undefined') return
  pasteListenersInstalled = true
  window.addEventListener('paste', (event) => {
    const images = extractPastedImages(event.clipboardData)
    if (images.length === 0) return
    const target = event.target
    const focusedZone =
      target instanceof Node
        ? Array.from(pasteZones).find((zone) => zone.root?.contains(target))
        : undefined
    const zone = focusedZone ?? lastHoveredZone ?? (pasteZones.size === 1 ? [...pasteZones][0] : null)
    if (!zone?.root) return
    event.preventDefault()
    zone.deliver(images)
  })
  window.addEventListener(
    'pointerover',
    (event) => {
      const target = event.target
      if (!(target instanceof Node)) return
      for (const zone of pasteZones) {
        if (zone.root?.contains(target)) {
          lastHoveredZone = zone
          return
        }
      }
    },
    true,
  )
}

/** 手动注册一个粘贴上传区域；供列表/循环渲染等无法在循环里调 hook 的场景使用。 */
export function registerPasteZone(deliver: (files: File[]) => void) {
  const zone: PasteZone = { root: null, deliver }
  pasteZones.add(zone)
  installPasteListeners()
  return {
    ref: (element: HTMLElement | null) => {
      zone.root = element
    },
    dispose: () => {
      pasteZones.delete(zone)
      if (lastHoveredZone === zone) lastHoveredZone = null
      zone.root = null
    },
  }
}

interface UseFilePasteOptions {
  /** 收到剪贴板里的图片文件（可能多张）时回调。 */
  onFiles: (files: File[]) => void
  disabled?: boolean
}

/** 粘贴图片上传：焦点所在区域优先，其次最近悬停的区域，仅一个区域时直接路由。 */
export function useFilePaste({ onFiles, disabled = false }: UseFilePasteOptions) {
  const stateRef = useRef({ onFiles, disabled })
  useLayoutEffect(() => {
    stateRef.current = { onFiles, disabled }
  })

  const zoneRef = useRef<ReturnType<typeof registerPasteZone> | null>(null)
  const pasteRef = useCallback((element: HTMLElement | null) => {
    if (element && !zoneRef.current) {
      zoneRef.current = registerPasteZone((files) => {
        if (!stateRef.current.disabled) stateRef.current.onFiles(files)
      })
    }
    zoneRef.current?.ref(element)
  }, [])

  useEffect(() => {
    return () => {
      zoneRef.current?.dispose()
      zoneRef.current = null
    }
  }, [])

  return { pasteRef }
}
