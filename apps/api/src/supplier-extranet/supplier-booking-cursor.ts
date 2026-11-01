import { BadRequestException } from '@nestjs/common'

export interface BookingCursor { createdAt: Date; id: string }

/** Opaque keyset cursor for (created_at desc, id desc). Carries no tenant or supplier: scope always comes from the authenticated context. */
export function encodeCursor(cursor: BookingCursor): string {
  return Buffer.from(JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id }), 'utf8').toString('base64url')
}

export function decodeCursor(raw: string): BookingCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown }
    if (typeof parsed.c !== 'string' || typeof parsed.i !== 'string' || parsed.i.length === 0 || parsed.i.length > 64) throw new Error('shape')
    const createdAt = new Date(parsed.c)
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== parsed.c) throw new Error('date')
    return { createdAt, id: parsed.i }
  } catch {
    throw new BadRequestException('Invalid cursor')
  }
}
