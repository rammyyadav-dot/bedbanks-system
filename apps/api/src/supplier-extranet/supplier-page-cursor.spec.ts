import { BadRequestException } from '@nestjs/common'
import { decodePageCursor, encodePageCursor } from './supplier-page-cursor'

describe('page cursor', () => {
  it('round-trips and carries no tenant or supplier', () => {
    const encoded = encodePageCursor(['Atlantis, The Palm', 'cmabc123'])
    expect(decodePageCursor(encoded, 2)).toEqual(['Atlantis, The Palm', 'cmabc123'])
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).not.toMatch(/tenant|supplier/i)
  })
  it.each([
    ['empty', ''],
    ['not json', 'not-base64-json'],
    ['no keys', Buffer.from('{}').toString('base64url')],
    ['wrong arity', encodePageCursor(['a'])],
    ['empty key', encodePageCursor(['a', ''])],
    ['non-string key', Buffer.from('{"k":["a",1]}').toString('base64url')],
    ['oversized key', encodePageCursor(['a', 'x'.repeat(201)])],
  ])('rejects %s', (_label, raw) => {
    expect(() => decodePageCursor(raw, 2)).toThrow(BadRequestException)
  })
})
