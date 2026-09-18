import { sanitizeAuditPayload } from './audit-payload'

describe('sanitizeAuditPayload', () => {
  it('redacts credentials, payment data and guest identifiers', () => {
    expect(sanitizeAuditPayload({
      passwordHash: 'hash', cookie: 'cookie', bearerToken: 'token', accessToken: 'token',
      pan: '4111111111111111', cvv: '123', supplierCredential: 'secret',
      guestEmail: 'guest@example.test', guestPhone: '+971500000000', passport: 'A1234567',
    })).toEqual({
      passwordHash: '[REDACTED]', cookie: '[REDACTED]', bearerToken: '[REDACTED]', accessToken: '[REDACTED]',
      pan: '[REDACTED]', cvv: '[REDACTED]', supplierCredential: '[REDACTED]',
      guestEmail: '[REDACTED]', guestPhone: '[REDACTED]', passport: '[REDACTED]',
    })
  })
})
