import { BadRequestException } from '@nestjs/common'
import { decodeCursor, encodeCursor } from './supplier-booking-cursor'

describe('booking cursor', () => {
  const cursor = { createdAt: new Date('2099-01-05T10:00:00.123Z'), id: 'cmabc123' }
  it('round-trips and carries no tenant or supplier', () => {
    const encoded = encodeCursor(cursor)
    expect(decodeCursor(encoded)).toEqual(cursor)
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).not.toMatch(/tenant|supplier/i)
  })
  it.each(['', 'not-base64-json', Buffer.from('{}').toString('base64url'), Buffer.from('{"c":"2099-01-01","i":"x"}').toString('base64url'), Buffer.from(`{"c":"2099-01-01T00:00:00.000Z","i":"${'x'.repeat(65)}"}`).toString('base64url'), Buffer.from('{"c":"nope","i":"x"}').toString('base64url')])('rejects %p', (raw) => {
    expect(() => decodeCursor(raw)).toThrow(BadRequestException)
  })
})
