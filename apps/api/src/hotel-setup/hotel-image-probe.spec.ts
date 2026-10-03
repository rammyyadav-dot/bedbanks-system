import { probeImage } from './hotel-image-probe'

const png = (w: number, h: number) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b }
const jpeg = (w: number, h: number, sof = 0xc0) => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const frame = Buffer.alloc(19); frame[0] = 0xff; frame[1] = sof; frame.writeUInt16BE(17, 2); frame[4] = 8; frame.writeUInt16BE(h, 5); frame.writeUInt16BE(w, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame, Buffer.alloc(8)])
}
const webpX = (w: number, h: number) => { const b = Buffer.alloc(40); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1'); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b }
const webpL = (w: number, h: number) => { const b = Buffer.alloc(40); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8L', 12, 'latin1'); b[20] = 0x2f; b.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 21); return b }
const webpLossy = (w: number, h: number) => { const b = Buffer.alloc(40); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8 ', 12, 'latin1'); b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); return b }

describe('probeImage (ADR 0027)', () => {
  it('reads type and size from the bytes themselves', () => {
    expect(probeImage(png(1600, 1200))).toEqual({ contentType: 'image/png', width: 1600, height: 1200 })
    expect(probeImage(jpeg(1920, 1080))).toEqual({ contentType: 'image/jpeg', width: 1920, height: 1080 })
    expect(probeImage(jpeg(1024, 768, 0xc2))).toEqual({ contentType: 'image/jpeg', width: 1024, height: 768 }) // progressive
    expect(probeImage(webpX(2400, 1600))).toEqual({ contentType: 'image/webp', width: 2400, height: 1600 })
    expect(probeImage(webpL(1000, 700))).toEqual({ contentType: 'image/webp', width: 1000, height: 700 })
    expect(probeImage(webpLossy(1280, 853))).toEqual({ contentType: 'image/webp', width: 1280, height: 853 })
  })
  it('rejects everything else, including files that only claim to be images', () => {
    expect(probeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull()
    expect(probeImage(Buffer.from('GIF89a' + 'x'.repeat(40)))).toBeNull()
    expect(probeImage(Buffer.from('%PDF-1.7 ' + 'x'.repeat(40)))).toBeNull()
    expect(probeImage(Buffer.from('<?php echo 1; ?>'))).toBeNull()
    expect(probeImage(Buffer.alloc(0))).toBeNull()
    expect(probeImage(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull() // truncated JPEG
    expect(probeImage(png(10, 10).subarray(0, 20))).toBeNull() // truncated PNG
  })
})
