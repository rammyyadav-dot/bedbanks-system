import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveApiDestination } from './runtime-api-proxy.mjs'

const hosted = (url) => ({ PORTAL_HOSTED: '1', API_INTERNAL_URL: url })
const A = hosted('https://api.staging.internal/api/v1')
const B = hosted('https://api.prod.internal/api/v1/')

test('same code, two environments: the destination follows the runtime env, nothing is baked', () => {
  assert.deepEqual(resolveApiDestination('/api/v1/auth/login', '?x=1', A), { ok: true, url: 'https://api.staging.internal/api/v1/auth/login?x=1' })
  assert.deepEqual(resolveApiDestination('/api/v1/auth/login', '?x=1', B), { ok: true, url: 'https://api.prod.internal/api/v1/auth/login?x=1' })
})
test('the bare prefix and nested paths resolve', () => {
  assert.equal(resolveApiDestination('/api/v1', '', A).url, 'https://api.staging.internal/api/v1')
  assert.equal(resolveApiDestination('/api/v1/hotels/123/rooms', '', A).url, 'https://api.staging.internal/api/v1/hotels/123/rooms')
})
test('non-API paths are not proxied', () => {
  for (const p of ['/', '/login', '/api', '/api/v10/x', '/api/v1x', '/apix/v1/a']) assert.equal(resolveApiDestination(p, '', A).status, 404, p)
})
test('hosted misconfiguration fails closed with a fixed reason and no URL in it', () => {
  for (const env of [{ PORTAL_HOSTED: '1' }, hosted('http://api/api/v1'), hosted('https://localhost/api/v1'), hosted('https://api/other'), hosted('not a url')]) {
    const r = resolveApiDestination('/api/v1/x', '', env)
    assert.deepEqual(r, { ok: false, status: 503, reason: 'portal_api_origin_misconfigured' })
  }
})
test('dot segments, encoded dot segments and backslashes cannot leave /api/v1', () => {
  for (const p of ['/api/v1/../docs', '/api/v1/%2e%2e/docs', '/api/v1/%2E%2E/docs', '/api/v1/a/../../docs', '/api/v1/..%2fdocs', '/api/v1/.%2e/docs', '/api/v1/..\\docs', '/api/v1/%2e%2e%5cdocs']) {
    const r = resolveApiDestination(p, '', A)
    // either rejected, or normalised but still inside /api/v1 on the same origin
    if (r.ok) assert.ok(new URL(r.url).pathname.startsWith('/api/v1/') && new URL(r.url).origin === 'https://api.staging.internal', `${p} -> ${r.url}`)
    else assert.equal(r.status, 404)
  }
  assert.equal(resolveApiDestination('/api/v1/../docs', '', A).ok, false)
  assert.equal(resolveApiDestination('/api/v1/%2e%2e/docs', '', A).ok, false)
})
test('a request path cannot change the origin (authority injection)', () => {
  for (const p of ['/api/v1//evil.example/x', '/api/v1/@evil.example/x', '/api/v1/\\@evil.example']) {
    const r = resolveApiDestination(p, '', A)
    if (r.ok) assert.equal(new URL(r.url).origin, 'https://api.staging.internal')
  }
})
test('local development keeps the documented default when not hosted', () => {
  assert.equal(resolveApiDestination('/api/v1/health', '', {}).url, 'http://localhost:3002/api/v1/health')
})
