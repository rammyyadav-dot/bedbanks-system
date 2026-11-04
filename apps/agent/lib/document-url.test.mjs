import assert from 'node:assert/strict'
import test from 'node:test'
import { replaceDocumentUrl, revokeDocumentUrl } from './document-url.ts'

test('Given a booking document object URL, When another document opens or the view closes, Then the previous URL is revoked', () => {
  const created = []
  const revoked = []
  const urls = {
    createObjectURL: () => { const url = `blob:${created.length + 1}`; created.push(url); return url },
    revokeObjectURL: (url) => { revoked.push(url) },
  }
  const registry = { current: null }
  assert.equal(replaceDocumentUrl(registry, '<p>one</p>', urls), 'blob:1')
  assert.equal(replaceDocumentUrl(registry, '<p>two</p>', urls), 'blob:2')
  assert.deepEqual(revoked, ['blob:1'])
  revokeDocumentUrl(registry, urls)
  assert.deepEqual(revoked, ['blob:1', 'blob:2'])
  assert.equal(registry.current, null)
})
