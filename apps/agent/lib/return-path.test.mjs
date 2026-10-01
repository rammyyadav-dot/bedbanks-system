import assert from 'node:assert/strict'
import test from 'node:test'
import { safeReturnPath } from './return-path.ts'

test('allows known internal paths', () => {
  for (const path of ['/', '/about', '/support', '/contact', '/news', '/access']) {
    assert.equal(safeReturnPath(path), path)
  }
  assert.equal(safeReturnPath('/support?x=1'), '/support')
})

test('rejects open redirects and unknown paths', () => {
  for (const value of [null, '', '//evil.example', 'https://evil.example', '/\\evil', '/%2F%2Fevil.example', '/about/../admin', '/login', 'javascript:alert(1)', '/support\0']) {
    assert.equal(safeReturnPath(value), '/')
  }
})
