import assert from 'node:assert/strict'
import test from 'node:test'
import { hotelImagePath } from './hotel-image.mjs'

test('builds the Agent image path from ids and escapes them', () => {
  assert.equal(hotelImagePath('h1', 'i1'), '/agent/hotels/h1/images/i1/content')
  assert.equal(hotelImagePath('a/b', '../c'), '/agent/hotels/a%2Fb/images/..%2Fc/content')
})
