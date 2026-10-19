import { BadRequestException } from '@nestjs/common'

/** Opaque keyset cursor for a list ordered by up to three text keys. Carries no tenant or supplier: scope always comes from the authenticated context. */
export function encodePageCursor(keys: readonly string[]): string {
  return Buffer.from(JSON.stringify({ k: keys }), 'utf8').toString('base64url')
}

export function decodePageCursor(raw: string, arity: number): string[] {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { k?: unknown }
    if (!Array.isArray(parsed.k) || parsed.k.length !== arity || parsed.k.some((key) => typeof key !== 'string' || key.length === 0 || key.length > 200)) throw new Error('shape')
    return parsed.k as string[]
  } catch {
    throw new BadRequestException('Invalid cursor')
  }
}
