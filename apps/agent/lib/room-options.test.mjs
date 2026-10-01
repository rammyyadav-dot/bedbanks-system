import assert from 'node:assert/strict'
import test from 'node:test'
import { selectableRoomCount, selectableRoomLabel } from './room-options.ts'

const room = (availability) => ({ rates: availability.map((value) => ({ availability: value })) })

test('counts a room group with an available rate', () => {
  assert.equal(selectableRoomCount([room(['available'])]), 1)
  assert.equal(selectableRoomLabel(1), '1 room option')
})

test('skips a room group whose rates are all sold out', () => {
  assert.equal(selectableRoomCount([room(['sold_out', 'sold_out'])]), 0)
})

test('counts only mixed groups that still have a selectable rate', () => {
  assert.equal(selectableRoomCount([
    room(['sold_out']),
    room(['sold_out', 'available']),
    room(['limited']),
  ]), 2)
  assert.equal(selectableRoomLabel(2), '2 room options')
})

test('reports zero selectable room groups', () => {
  assert.equal(selectableRoomCount([room(['sold_out']), room(['sold_out'])]), 0)
  assert.equal(selectableRoomCount([]), 0)
  assert.equal(selectableRoomLabel(0), '0 room options')
})
