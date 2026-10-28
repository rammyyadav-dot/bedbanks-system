import { deflateSync } from 'zlib'
import type * as Sharp from 'sharp'

// sharp's CommonJS entry is the factory itself, but its type declarations are ESM (default export); this build has no esModuleInterop.
const sharp = require('sharp') as typeof Sharp.default

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

/** A complete, decodable 8-bit greyscale PNG of the given size. `seed` is written into the first row, so different seeds give different bytes (and hashes). */
export function realPng(width: number, height: number, seed = ''): Buffer<ArrayBuffer> {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0
  const rows = Buffer.alloc(height * (width + 1)); Buffer.from(seed, 'latin1').copy(rows, 1, 0, Math.min(seed.length, width))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

/** A complete, decodable JPEG. The seed goes into a COM segment, which decoders skip, so different seeds give different bytes. */
export async function realJpeg(width: number, height: number, seed = ''): Promise<Buffer<ArrayBuffer>> {
  const base: Buffer<ArrayBuffer> = Buffer.from(await sharp({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 160 } } }).jpeg().toBuffer())
  const comment = Buffer.from(seed, 'latin1')
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), comment]); com.writeUInt16BE(comment.length + 2, 2)
  return Buffer.concat([base.subarray(0, 2), com, base.subarray(2)])
}
