import { createHash } from 'crypto'
import { ipAllowed, isAccessToken, newAccessToken, newCredentialMaterial, parseApiKey, parseClientCredentials, parseScopeParam, sha256Hex, toWireScopes, WIRE_SCOPES } from './distribution-credentials'

describe('distribution credential formats', () => {
  it('new credential material matches the database checks and parses back', () => {
    const m = newCredentialMaterial()
    expect(m.keyId).toMatch(/^[a-z0-9]{20}$/)
    expect(m.secretHash).toMatch(/^[0-9a-f]{64}$/)
    expect(m.secretHash).toBe(createHash('sha256').update(m.secret).digest('hex'))
    expect(parseApiKey(m.apiKey)).toEqual({ keyId: m.keyId, secret: m.secret })
    expect(parseClientCredentials(m.keyId, m.secret)).toEqual({ keyId: m.keyId, secret: m.secret })
    expect(newCredentialMaterial().keyId).not.toBe(m.keyId)
  })

  it('refuses malformed keys and client credentials before any hashing or query', () => {
    const m = newCredentialMaterial()
    for (const bad of ['', m.apiKey.slice(1), `${m.apiKey}x`, m.apiKey.toUpperCase(), m.apiKey.replace('fbk_', 'fbt_'), `${m.apiKey}\n`, `fbk_${m.keyId}_${m.secret.slice(0, 42)}'`]) expect(parseApiKey(bad)).toBeNull()
    expect(parseClientCredentials(m.keyId.toUpperCase(), m.secret)).toBeNull()
    expect(parseClientCredentials(m.keyId, `${m.secret}=`)).toBeNull()
    expect(parseClientCredentials(undefined, m.secret)).toBeNull()
    expect(parseClientCredentials(m.keyId, ['x'])).toBeNull()
  })

  it('access tokens have their own prefix and shape', () => {
    const token = newAccessToken()
    expect(isAccessToken(token)).toBe(true)
    expect(newAccessToken()).not.toBe(token)
    for (const bad of ['', token.slice(1), `${token}a`, token.replace('fbt_', 'fbk_'), newCredentialMaterial().apiKey]) expect(isAccessToken(bad)).toBe(false)
    expect(sha256Hex(token)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('maps scopes between the wire and the database, in a stable order', () => {
    expect(WIRE_SCOPES).toEqual(['search', 'checkrate', 'book', 'cancel', 'bookings:read'])
    expect(parseScopeParam(undefined)).toEqual({ ok: true, scopes: [] })
    expect(parseScopeParam('  ')).toEqual({ ok: true, scopes: [] })
    expect(parseScopeParam('book search search')).toEqual({ ok: true, scopes: ['BOOK', 'SEARCH'] })
    expect(parseScopeParam('bookings:read')).toEqual({ ok: true, scopes: ['BOOKINGS_READ'] })
    for (const bad of ['SEARCH', 'search,book', 'admin', 'search\tbook', 42, 'x'.repeat(201)]) expect(parseScopeParam(bad)).toEqual({ ok: false })
    expect(toWireScopes(['BOOKINGS_READ', 'SEARCH', 'UNKNOWN'])).toEqual(['search', 'bookings:read'])
  })

  it('the IP allowlist allows any address when empty and fails closed otherwise', () => {
    expect(ipAllowed('203.0.113.9', [])).toBe(true)
    expect(ipAllowed(undefined, [])).toBe(true)
    expect(ipAllowed('203.0.113.9', ['203.0.113.0/24'])).toBe(true)
    expect(ipAllowed('::ffff:203.0.113.9', ['203.0.113.0/24'])).toBe(true)
    expect(ipAllowed('203.0.114.1', ['203.0.113.0/24'])).toBe(false)
    expect(ipAllowed('2001:db8::1', ['2001:db8::/32'])).toBe(true)
    expect(ipAllowed('2001:db9::1', ['2001:db8::/32'])).toBe(false)
    expect(ipAllowed('198.51.100.7', ['198.51.100.7'])).toBe(true)
    expect(ipAllowed(undefined, ['203.0.113.0/24'])).toBe(false)
    expect(ipAllowed('not-an-ip', ['0.0.0.0/0'])).toBe(false)
    expect(ipAllowed('203.0.113.9', ['garbage', '203.0.113.0/99'])).toBe(false)
  })
})
