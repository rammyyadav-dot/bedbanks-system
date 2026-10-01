import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { buildContentSecurityPolicy, generateNonce } from '../lib/csp'

const read = (file: string) => readFileSync(resolve(import.meta.dirname, '..', file), 'utf8')

test('next.config.ts keeps the non-CSP browser protections and no longer sets a static CSP', () => {
  const source = read('next.config.ts')
  for (const expected of ['Permissions-Policy', 'Referrer-Policy', 'X-Content-Type-Options', 'X-Frame-Options', 'Strict-Transport-Security']) assert.ok(source.includes(expected), expected)
  assert.ok(!source.includes('Content-Security-Policy'), 'a static CSP would be intersected with the nonce CSP from proxy.ts')
})

test('the production policy gates scripts by nonce and never allows unsafe-inline or unsafe-eval', () => {
  const policy = buildContentSecurityPolicy({ nonce: 'abc123==', development: false })
  const scriptSrc = policy.split('; ').find((directive) => directive.startsWith('script-src '))!
  assert.equal(scriptSrc, "script-src 'self' 'nonce-abc123==' 'strict-dynamic'")
  assert.ok(!policy.includes('unsafe-inline') && !policy.includes('unsafe-eval'))
  for (const expected of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "frame-src 'none'", 'upgrade-insecure-requests']) assert.ok(policy.includes(expected), expected)
  assert.ok(!/https?:\/\//.test(policy), 'no third-party origin is allow-listed')
})

test('development allowances stay out of production', () => {
  const development = buildContentSecurityPolicy({ nonce: 'n', development: true })
  assert.ok(development.includes("'unsafe-eval'") && development.includes('ws:') && !development.includes('upgrade-insecure-requests'))
  assert.ok(development.includes("style-src 'self' 'unsafe-inline'"))
  const production = buildContentSecurityPolicy({ nonce: 'n', development: false })
  assert.ok(!production.includes('ws:') && !production.includes("'unsafe-eval'") && !production.includes('unsafe-inline'))
  assert.ok(production.includes("style-src 'self' 'nonce-n'"))
})

test('nonces are 128-bit, valid base64 and unique per call', () => {
  const nonces = new Set(Array.from({ length: 200 }, generateNonce))
  assert.equal(nonces.size, 200)
  for (const nonce of nonces) { assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/); assert.equal(Buffer.from(nonce, 'base64').length, 16) }
})

test('the proxy sets the nonce CSP on request and response, forbids shared caching, and keeps portal redirects', () => {
  const source = read('proxy.ts')
  for (const expected of ["requestHeaders.set('Content-Security-Policy'", "response.headers.set('Content-Security-Policy'", "'private, no-store", 'portalRedirectUrl', "NextResponse.redirect"]) assert.ok(source.includes(expected), expected)
  assert.match(source, /matcher:[^\n]*_next\/static[^\n]*opengraph-image/)
})
