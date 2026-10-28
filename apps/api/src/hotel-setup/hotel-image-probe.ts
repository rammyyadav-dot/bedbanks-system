import type * as Sharp from 'sharp'
import { HOTEL_IMAGE_LIMITS, HOTEL_IMAGE_TYPES, type HotelImageType } from '@bedbanks/contracts'
// sharp's CommonJS entry is the factory itself, but its type declarations are ESM (default export); this build has no esModuleInterop.
const sharp = require('sharp') as typeof Sharp.default

export interface ImageProbe { contentType: HotelImageType; width: number; height: number }

const FORMAT_TYPE: Record<string, HotelImageType> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
/** Decoder ceiling: the largest accepted frame. libvips refuses anything bigger before it allocates pixel memory. */
const MAX_PIXELS = HOTEL_IMAGE_LIMITS.maxWidth * HOTEL_IMAGE_LIMITS.maxHeight

/**
 * Identifies an image from its own bytes (never from the client's declared type or file name), reads its pixel size and then fully decodes it,
 * so a header with no (or truncated, or corrupt) pixel data is rejected before anything is stored. Supports JPEG, PNG and WebP only.
 * Returns null for anything else, for a file too damaged to read a size from, or for one that fails to decode.
 * Resource use is bounded: the header size is checked against the upload limits before decoding, libvips is capped at MAX_PIXELS and reads are
 * sequential, so decoded pixels stream through the statistics pass and are never buffered.
 */
export async function inspectImage(buf: Buffer): Promise<ImageProbe | null> {
  const header = probeImage(buf)
  if (!header) return null
  const { minWidth, minHeight, maxWidth, maxHeight } = HOTEL_IMAGE_LIMITS
  // Out-of-range sizes are reported by the caller as a dimension error; decoding an image we will refuse anyway would only cost memory.
  if (header.width < minWidth || header.height < minHeight || header.width > maxWidth || header.height > maxHeight) return header
  try {
    const image = sharp(buf, { failOn: 'error', limitInputPixels: MAX_PIXELS, sequentialRead: true })
    const meta = await image.metadata()
    const contentType = meta.format ? FORMAT_TYPE[meta.format] : undefined
    if (!contentType || contentType !== header.contentType || meta.width !== header.width || meta.height !== header.height) return null
    await image.stats() // decodes every scanline; failOn:'error' turns truncation or corruption into a rejection
    return { contentType, width: header.width, height: header.height }
  } catch {
    return null
  }
}

/**
 * Header-only inspection: type and claimed size, with no pixel validation. Exported for tests and for the pre-decode size check; uploads must use
 * inspectImage.
 */
export function probeImage(buf: Buffer): ImageProbe | null {
  return probePng(buf) ?? probeJpeg(buf) ?? probeWebp(buf)
}

export const isAllowedType = (type: string): type is HotelImageType => (HOTEL_IMAGE_TYPES as readonly string[]).includes(type)

function probePng(b: Buffer): ImageProbe | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length < 24 || !sig.every((v, i) => b[i] === v) || b.toString('latin1', 12, 16) !== 'IHDR') return null
  return { contentType: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function probeJpeg(b: Buffer): ImageProbe | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue }
    const marker = b[i + 1]
    if (marker === 0xff) { i++; continue }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    const length = b.readUInt16BE(i + 2)
    if (length < 2) return null
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { contentType: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    }
    i += 2 + length
  }
  return null
}

function probeWebp(b: Buffer): ImageProbe | null {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null
  const kind = b.toString('latin1', 12, 16)
  if (kind === 'VP8X') return { contentType: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
  if (kind === 'VP8L' && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21)
    return { contentType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (kind === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { contentType: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  }
  return null
}
