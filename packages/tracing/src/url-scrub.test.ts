import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scrubbedUrl, scrubSpanUrlAttributes } from './url-scrub'

test('drops the query string and fragment from an absolute URL', () => {
  assert.equal(scrubbedUrl('https://supplier.example.com/v1/search?apiKey=secret&q=dubai#x'), 'https://supplier.example.com/v1/search')
})
test('drops the query string from a path', () => {
  assert.equal(scrubbedUrl('/api/v1/auth/reset?token=abc'), '/api/v1/auth/reset')
})
test('never echoes an unparseable input', () => {
  assert.equal(scrubbedUrl('http://[bad'), '[unparseable-url]')
})
test('rewrites every url attribute in place and blanks the query', () => {
  const attrs: Record<string, unknown> = {
    'http.url': 'http://api.internal/api/v1/x?token=SECRET', 'http.target': '/api/v1/x?token=SECRET', 'url.full': 'https://h/p?a=SECRET',
    'url.query': 'token=SECRET', 'http.method': 'GET', 'http.status_code': 200,
  }
  scrubSpanUrlAttributes(attrs)
  assert.equal(JSON.stringify(attrs).includes('SECRET'), false)
  assert.equal(attrs['http.url'], 'http://api.internal/api/v1/x')
  assert.equal(attrs['http.method'], 'GET')
  assert.equal(attrs['http.status_code'], 200)
})
test('leaves spans without url attributes alone', () => {
  const attrs: Record<string, unknown> = { 'supplier.id': 'a' }
  scrubSpanUrlAttributes(attrs)
  assert.deepEqual(attrs, { 'supplier.id': 'a' })
})
