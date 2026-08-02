/**
 * Brand-driven color system for the Proforma Invoice renderers.
 *
 * A single brand color (usually taken from the company logo) is expanded into a
 * cohesive palette so the whole PI — PDF, on-screen preview and Excel export —
 * shares one consistent, formal tone. All renderers must derive their colors
 * from `derivePalette()` rather than hard-coding hex values.
 */

/** Elegant deep slate-navy used when a company has no brand color set. */
export const DEFAULT_ACCENT = '#1F3A5F'

export interface PiPalette {
  /** The brand color, normalized to #RRGGBB. */
  accent: string
  /** A darker shade of the brand color for the grand-total emphasis. */
  accentDark: string
  /** Very light brand tint for zebra rows / soft panels. */
  tint: string
  /** Slightly stronger brand tint for header meta / bank panels. */
  tintStrong: string
  /** Hairline border in the brand hue. */
  border: string
  /** Readable text color to place on top of `accent` (white or near-black). */
  onAccent: string
  /** Neutral muted text. */
  muted: string
  /** Primary body text. */
  text: string
  /** Secondary body text. */
  softText: string
}

type RGB = [number, number, number]

function hexToRgb(hex: string): RGB | null {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

function rgbToHex([r, g, b]: RGB): string {
  return (
    '#' +
    [r, g, b]
      .map((v) => clamp(v).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}

/** Linear blend of `rgb` toward `target` by `amount` (0..1). */
function mix(rgb: RGB, target: RGB, amount: number): RGB {
  return [
    rgb[0] + (target[0] - rgb[0]) * amount,
    rgb[1] + (target[1] - rgb[1]) * amount,
    rgb[2] + (target[2] - rgb[2]) * amount,
  ]
}

const WHITE: RGB = [255, 255, 255]
const BLACK: RGB = [0, 0, 0]

/** Relative luminance (0..1) used to decide on-accent text color. */
function luminance([r, g, b]: RGB): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/**
 * Expand a single brand color into the full PI palette. Falls back to an
 * elegant default when the input is missing or malformed.
 */
export function derivePalette(input?: string | null): PiPalette {
  const rgb = (input && hexToRgb(input)) || hexToRgb(DEFAULT_ACCENT)!
  const accent = rgbToHex(rgb)
  return {
    accent,
    accentDark: rgbToHex(mix(rgb, BLACK, 0.3)),
    tint: rgbToHex(mix(rgb, WHITE, 0.94)),
    tintStrong: rgbToHex(mix(rgb, WHITE, 0.87)),
    border: rgbToHex(mix(rgb, WHITE, 0.72)),
    onAccent: luminance(rgb) > 0.62 ? '#1A1A1A' : '#FFFFFF',
    muted: '#6B7280',
    text: '#1F2937',
    softText: '#4B5563',
  }
}

/** Convert a #RRGGBB hex to the 'FFRRGGBB' ARGB form ExcelJS expects. */
export function toArgb(hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return 'FF' + DEFAULT_ACCENT.replace('#', '').toUpperCase()
  return (
    'FF' +
    rgb
      .map((v) => clamp(v).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}
