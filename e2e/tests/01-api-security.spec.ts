import { expect, test } from '@playwright/test'
import { ORIGINS } from '../support/config'
import { call, login, offerSearchBody, SELLABLE_STAY } from '../support/api'
import { fixtures } from '../support/helpers'

test.describe('API security boundary (real database, strict runtime role)', () => {
  test('S1 protected routes refuse anonymous callers with 401', async () => {
    for (const path of ['/agent/context', '/supply/hotels', '/admin/dashboard', '/supplier/extranet/context']) {
      const r = await call(path)
      expect(r.status, path).toBe(401)
    }
  })

  test('S2 sign-in cookie is HttpOnly, Secure, SameSite and host-only', async () => {
    const { setCookie, reply } = await login('agent')
    expect(reply.status).toBe(200)
    const attrs = setCookie.split(';').map((a) => a.trim().toLowerCase())
    expect(attrs).toContain('httponly')
    expect(attrs).toContain('secure')
    expect(attrs.some((a) => a.startsWith('samesite='))).toBe(true)
    expect(attrs.some((a) => a.startsWith('domain='))).toBe(false)
    expect(JSON.stringify(reply.body)).not.toMatch(/passwordHash|\$argon2|\$2[aby]\$/)
  })

  test('S3 wrong password is refused with a generic message and no cookie', async () => {
    const r = await call('/auth/login', { json: { email: 'preview-admin@example.test', password: 'definitely-wrong-password' }, origin: ORIGINS.admin })
    expect(r.status).toBe(401)
    expect(r.headers.get('set-cookie')).toBeNull()
    expect(r.body.error.message).toBe('Invalid email or password')
  })

  test('S4 a foreign website cannot sign in or sign out on a user’s behalf (untrusted origin)', async () => {
    const { cookie } = await login('admin')
    const signIn = await call('/auth/login', { json: { email: 'preview-admin@example.test', password: 'whatever-123' }, origin: 'https://evil.example' })
    expect(signIn.status).toBe(403)
    const signOut = await call('/auth/logout', { method: 'POST', cookie, origin: 'https://evil.example' })
    expect(signOut.status).toBe(403)
    // The session survived the forged sign-out.
    expect((await call('/admin/dashboard', { cookie })).status).toBe(200)
  })

  test('S5 credentialed CORS never reflects an unknown origin', async () => {
    const res = await fetch(`${ORIGINS.api}/api/v1/auth/login`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example')
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  test('S6 authentication is not authorization: each role only reaches its own routes', async () => {
    const admin = (await login('admin')).cookie
    const restricted = (await login('restricted')).cookie
    const agent = (await login('agent')).cookie
    expect((await call('/supply/hotels', { cookie: admin })).status).toBe(200)
    expect((await call('/supply/hotels', { cookie: restricted })).status).toBe(403)
    expect((await call('/admin/dashboard', { cookie: restricted })).status).toBe(403)
    expect((await call('/supply/hotels', { cookie: agent })).status).toBe(403)
    expect((await call('/supplier/extranet/context', { cookie: agent })).status).toBe(403)
  })

  test('S7 the tenant comes from the server session: a browser-supplied tenant is refused', async () => {
    const { tenantA } = fixtures()
    const tenantB = (await login('tenantB')).cookie
    const own = await call('/agent/context', { cookie: tenantB })
    expect(own.status).toBe(200)
    const claimed = await call('/agent/context', { cookie: tenantB, headers: { 'x-fbeds-tenant-id': tenantA } })
    expect(claimed.status).toBe(403)
  })

  test('S8 Tenant B never sees Tenant A’s hotels in search', async () => {
    const f = fixtures()
    const stay = SELLABLE_STAY()
    const a = await call('/agent/search', { cookie: (await login('agent')).cookie, headers: { 'x-fbeds-tenant-id': f.tenantA }, json: offerSearchBody(stay.checkIn, stay.checkOut) })
    expect(a.status).toBeLessThan(300)
    const aNames: string[] = a.body.data.hotels.map((h: any) => h.name)
    expect(aNames).toEqual(expect.arrayContaining(['Preview Creek Dubai', 'Preview Marina Dubai']))
    const b = await call('/agent/search', { cookie: (await login('tenantB')).cookie, headers: { 'x-fbeds-tenant-id': f.tenantB }, json: offerSearchBody(stay.checkIn, stay.checkOut) })
    expect(b.status).toBeLessThan(300)
    const bNames: string[] = b.body.data.hotels.map((h: any) => h.name)
    expect(bNames).toEqual(['Preview Other Tenant Dubai']) // positive control: Tenant B does see its own hotel
    for (const name of aNames) expect(bNames).not.toContain(name)
  })

  test('S9 suppliers: revoked and non-member accounts are refused, members see only their organisation', async () => {
    expect((await call('/supplier/extranet/context', { cookie: (await login('supplierRevoked')).cookie })).status).toBe(403)
    const editor = await call('/supplier/extranet/context', { cookie: (await login('supplierEditor')).cookie })
    expect(editor.status).toBe(200)
    expect(editor.body.data.organization.displayName).toBe('Preview Supplier Alpha')
    const beta = await call('/supplier/extranet/context', { cookie: (await login('supplierBeta')).cookie })
    expect(beta.status).toBe(200)
    expect(beta.body.data.organization.displayName).not.toBe('Preview Supplier Alpha')
  })

  test('S10 sign-out ends the session server-side', async () => {
    const { cookie } = await login('agent')
    expect((await call('/agent/context', { cookie })).status).toBe(200)
    expect((await call('/auth/logout', { method: 'POST', cookie, origin: ORIGINS.agent })).status).toBeLessThan(300)
    expect((await call('/agent/context', { cookie })).status).toBe(401)
  })
})
