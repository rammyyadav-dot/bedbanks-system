/** sRGB hex <-> OKLCH, used only to derive the dark theme from the light one. Display colours, not money: floats are fine here. */

export interface Rgba { r: number; g: number; b: number; a: number }

export function parseHex(hex: string): Rgba {
  let h = hex.replace(/^#/, '').toLowerCase()
  if (h.length === 3 || h.length === 4) h = Array.from(h).map((c) => c + c).join('')
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) throw new Error(`Invalid hex colour: ${hex}`)
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 }
}

/** Canonical lowercase 6- or 8-digit form. */
export function normalizeHex(hex: string): string {
  const { r, g, b, a } = parseHex(hex)
  const byte = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a * 255) : ''}`
}

const toLinear = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const fromLinear = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

export function toOklch({ r, g, b }: Rgba): { L: number; C: number; h: number } {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { L, C: Math.hypot(A, B), h: Math.atan2(B, A) }
}

function fromOklch(L: number, C: number, h: number): { r: number; g: number; b: number; inGamut: boolean } {
  const A = C * Math.cos(h)
  const B = C * Math.sin(h)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
  const inGamut = lin.every((v) => v >= -0.0005 && v <= 1.0005)
  const [r, g, b] = lin.map((v) => Math.min(255, Math.max(0, fromLinear(Math.min(1, Math.max(0, v))))))
  return { r: r!, g: g!, b: b!, inGamut }
}

/** Relative luminance (WCAG), for contrast checks. */
export function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/**
 * Lightness curve for the dark theme: monotonic and decreasing, so every foreground/background pair keeps its order.
 * It is steeper than a plain reflection through the dark-to-mid range (text on a pastel fill must flip to clearly light)
 * and nearly flat around the mid-tones, so accent colours keep roughly the lightness they always had.
 */
const CURVE: ReadonlyArray<readonly [number, number]> = [[0, 0.95], [0.15, 0.92], [0.3, 0.85], [0.5, 0.7], [0.6, 0.6], [0.75, 0.38], [0.9, 0.2], [1, 0.15]]
export function darkLightness(L: number): number {
  const x = Math.min(1, Math.max(0, L))
  for (let i = 1; i < CURVE.length; i++) {
    const [x1, y1] = CURVE[i]!
    const [x0, y0] = CURVE[i - 1]!
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0)
  }
  return CURVE[CURVE.length - 1]![1]
}

/**
 * Dark counterpart of a light-theme colour: lightness is reflected (white -> near-black surface, near-black text ->
 * near-white text) so every foreground/background pair keeps its contrast; hue is kept; pastel fills lose chroma so
 * they read as muted tints. Translucent dark colours are scrims/shadows and stay as they are.
 */
export function darkVariant(hex: string): string {
  const color = parseHex(hex)
  const { L, C, h } = toOklch(color)
  if (color.a < 1 && L < 0.35) return normalizeHex(hex)
  const L2 = darkLightness(L)
  let C2 = C * (L > 0.85 ? 0.55 : L > 0.65 ? 0.8 : 1)
  let out = fromOklch(L2, C2, h)
  for (let i = 0; i < 12 && !out.inGamut; i++) { C2 *= 0.9; out = fromOklch(L2, C2, h) }
  const byte = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  return `#${byte(out.r)}${byte(out.g)}${byte(out.b)}${color.a < 1 ? byte(color.a * 255) : ''}`
}
