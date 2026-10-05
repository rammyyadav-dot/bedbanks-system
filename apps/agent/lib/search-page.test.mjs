import assert from 'node:assert/strict'
import test from 'node:test'
import { appendHotelPage, paginationAfterLoadMore } from './search-page.ts'
import { resultWindow } from './result-window.ts'

test('load more keeps the window start and the server total, so "Showing 1–N of total" stays accurate', () => {
  const first = { limit: 25, offset: 0, total: 100, hasMore: true, nextOffset: 25 }
  const second = { limit: 25, offset: 25, total: 100, hasMore: true, nextOffset: 50 }
  const merged = paginationAfterLoadMore(first, second, 50)
  assert.deepEqual(merged, { limit: 25, offset: 0, total: 100, hasMore: true, nextOffset: 50 })
  assert.deepEqual(resultWindow(merged.offset, 50, merged.total), { start: 1, end: 50, total: 100 })
})

test('load more after a page jump keeps the first visible offset', () => {
  const merged = paginationAfterLoadMore({ offset: 50 }, { limit: 25, offset: 75, total: 100, hasMore: false }, 50)
  assert.deepEqual(resultWindow(merged.offset, 50, merged.total), { start: 51, end: 100, total: 100 })
  assert.equal(merged.hasMore, false)
})

test('a missing next page closes pagination without inventing a total', () => {
  assert.deepEqual(paginationAfterLoadMore({ offset: 0 }, undefined, 30), { offset: 0, total: 30, hasMore: false })
})

test('appending a page never duplicates a hotel', () => {
  const merged = appendHotelPage([{ hotelId: 'a' }, { hotelId: 'b' }], [{ hotelId: 'b' }, { hotelId: 'c' }])
  assert.deepEqual(merged.hotels.map((h) => h.hotelId), ['a', 'b', 'c'])
  assert.deepEqual(merged.added.map((h) => h.hotelId), ['c'])
})
