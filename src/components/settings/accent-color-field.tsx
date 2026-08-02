'use client'

import { useEffect, useState } from 'react'
import { Pipette } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DEFAULT_ACCENT } from '@/lib/pi-theme'
import { toImageSrc } from '@/lib/supabase/image'

const HEX_RE = /^#[0-9a-fA-F]{6}$/

/**
 * Extract the dominant, reasonably-saturated color from an image URL using a
 * canvas. Grayscale / near-white / near-black pixels are down-weighted so the
 * result reflects the logo's real brand hue.
 */
async function extractDominantColor(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const size = 60
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) return resolve(null)
        ctx.drawImage(img, 0, 0, size, size)
        const { data } = ctx.getImageData(0, 0, size, size)

        const buckets = new Map<string, { r: number; g: number; b: number; w: number }>()
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i]
          const g = data[i + 1]
          const b = data[i + 2]
          const a = data[i + 3]
          if (a < 128) continue
          const max = Math.max(r, g, b)
          const min = Math.min(r, g, b)
          if (max > 245 && min > 245) continue // near-white
          if (max < 18) continue // near-black
          const sat = max === 0 ? 0 : (max - min) / max
          const weight = 1 + sat * 4 // favor vivid brand colors
          const key = `${r >> 4}-${g >> 4}-${b >> 4}`
          const cur = buckets.get(key) ?? { r: 0, g: 0, b: 0, w: 0 }
          cur.r += r * weight
          cur.g += g * weight
          cur.b += b * weight
          cur.w += weight
          buckets.set(key, cur)
        }
        if (buckets.size === 0) return resolve(null)
        let best: { r: number; g: number; b: number; w: number } | null = null
        for (const v of buckets.values()) {
          if (!best || v.w > best.w) best = v
        }
        if (!best) return resolve(null)
        const toHex = (n: number) =>
          Math.max(0, Math.min(255, Math.round(n / best!.w)))
            .toString(16)
            .padStart(2, '0')
        resolve(`#${toHex(best.r)}${toHex(best.g)}${toHex(best.b)}`.toUpperCase())
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

export function AccentColorField({
  defaultValue,
  logoUrl,
}: {
  defaultValue?: string | null
  logoUrl?: string
}) {
  const [color, setColor] = useState((defaultValue || '').toUpperCase())
  const [picking, setPicking] = useState(false)

  // Keep the picker in sync when switching between profiles.
  useEffect(() => {
    setColor((defaultValue || '').toUpperCase())
  }, [defaultValue])

  const valid = HEX_RE.test(color)
  const swatch = valid ? color : DEFAULT_ACCENT

  async function pickFromLogo() {
    if (!logoUrl) {
      toast.error('请先上传 Logo')
      return
    }
    setPicking(true)
    try {
      const hex = await extractDominantColor(toImageSrc(logoUrl))
      if (hex) {
        setColor(hex)
        toast.success('已从 Logo 取色')
      } else {
        toast.error('无法从 Logo 取色，请手动选择')
      }
    } finally {
      setPicking(false)
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="accent_color">品牌主色</Label>
      {/* Submitted with the form; empty string clears the stored color. */}
      <input type="hidden" name="accent_color" value={valid ? color : ''} />
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label="选择品牌主色"
          value={swatch}
          onChange={(e) => setColor(e.target.value.toUpperCase())}
          className="h-9 w-12 cursor-pointer rounded border bg-transparent p-1"
        />
        <Input
          value={color}
          onChange={(e) => setColor(e.target.value.toUpperCase())}
          placeholder={DEFAULT_ACCENT}
          className="max-w-[140px] font-mono"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={pickFromLogo}
          disabled={picking || !logoUrl}
        >
          <Pipette className="mr-1 h-4 w-4" />
          {picking ? '取色中…' : '从 Logo 取色'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        PI 单据（PDF / 预览 / Excel）的整体色调会围绕此颜色生成。留空则使用系统默认深蓝。
      </p>
    </div>
  )
}
