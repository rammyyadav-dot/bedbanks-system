import assert from 'node:assert/strict'
import test from 'node:test'
import { averageNightlyMinor, filterCount, hotelBoards, roomFromMinor, sameFilters, visibleRooms } from './listing.ts'

const rate = (id, board, amountMinor, extra = {}) => ({
  offerId: id, boardBasisId: board, boardBasisName: board === 'bb' ? 'Bed & Breakfast' : 'Room Only', availability: 'available',
  cancellation: { refundable: true, summary: '' }, total: { amountMinor, currency: 'AED' }, ...extra,
})

test('average nightly amount is integer minor units, rounded half up, and refuses bad input', () => {
  assert.equal(averageNightlyMinor(90000, 3), 30000)
  assert.equal(averageNightlyMinor(100000, 3), 33333)
  assert.equal(averageNightlyMinor(100001, 2), 50001)
  assert.equal(averageNightlyMinor(5, 2), 3)
  assert.equal(averageNightlyMinor(0, 2), null)
  assert.equal(averageNightlyMinor(1000, 0), null)
  assert.equal(averageNightlyMinor(1000, null), null)
  assert.equal(averageNightlyMinor(10.5, 2), null)
})

test('filter comparison ignores order and empty selections; the count reflects each selection', () => {
  assert.equal(sameFilters(undefined, {}), true)
  assert.equal(sameFilters({ starRatings: [5, 4] }, { starRatings: [4, 5] }), true)
  assert.equal(sameFilters({ starRatings: [] }, undefined), true)
  assert.equal(sameFilters({ refundableOnly: false }, undefined), true)
  assert.equal(sameFilters({ maxPriceMinor: 100 }, { maxPriceMinor: 200 }), false)
  assert.equal(sameFilters({ boardBasisIds: ['bb'] }, undefined), false)
  assert.equal(filterCount(undefined), 0)
  assert.equal(filterCount({ starRatings: [4, 5], refundableOnly: true, minPriceMinor: 1, maxPriceMinor: 9 }), 4)
})

test('hotel page narrows rates on screen without re-pricing and drops empty room groups', () => {
  const rooms = [
    { roomTypeId: 'dbl', name: 'Double', rates: [rate('a', 'ro', 50000), rate('b', 'bb', 60000, { cancellation: { refundable: false, summary: '' } })] },
    { roomTypeId: 'ste', name: 'Suite', rates: [rate('c', 'ro', 90000)] },
  ]
  assert.deepEqual(hotelBoards(rooms), [{ id: 'ro', name: 'Room Only' }, { id: 'bb', name: 'Bed & Breakfast' }])
  assert.deepEqual(visibleRooms(rooms, { boardBasisId: 'bb', refundableOnly: false }).map((room) => room.rates.map((r) => r.offerId)), [['b']])
  assert.deepEqual(visibleRooms(rooms, { boardBasisId: 'bb', refundableOnly: true }), [])
  assert.equal(visibleRooms(rooms, { boardBasisId: null, refundableOnly: false }).length, 2)
  assert.equal(visibleRooms(rooms, { boardBasisId: null, refundableOnly: false })[0].rates[0].total.amountMinor, 50000)
})

test('hotel page also narrows by room name and a sell-price range', () => {
  const rooms = [
    { roomTypeId: 'dbl', name: 'Double Deluxe', rates: [rate('a', 'ro', 50000, { sellAmountMinor: 50000 })] },
    { roomTypeId: 'ste', name: 'Executive Suite', rates: [rate('b', 'ro', 90000, { sellAmountMinor: 90000 })] },
  ]
  assert.deepEqual(visibleRooms(rooms, { boardBasisId: null, refundableOnly: false, roomNameQuery: 'suite' }).map((room) => room.roomTypeId), ['ste'])
  assert.deepEqual(visibleRooms(rooms, { boardBasisId: null, refundableOnly: false, roomNameQuery: 'DOUBLE' }).map((room) => room.roomTypeId), ['dbl'])
  assert.deepEqual(visibleRooms(rooms, { boardBasisId: null, refundableOnly: false, minSellMinor: 60000 }).map((room) => room.roomTypeId), ['ste'])
  assert.deepEqual(visibleRooms(rooms, { boardBasisId: null, refundableOnly: false, maxSellMinor: 60000 }).map((room) => room.roomTypeId), ['dbl'])
  assert.equal(visibleRooms(rooms, { boardBasisId: null, refundableOnly: false, roomNameQuery: 'no such room' }).length, 0)
})

test('the price-range filter compares the client price actually shown, not the pre-markup agency price', () => {
  // AED 850 agency price; at a 20% client markup the bold number on screen is AED 1,020.
  const rooms = [{ roomTypeId: 'dlx', name: 'Deluxe', rates: [rate('a', 'ro', 85000, { sellAmountMinor: 85000 })] }]
  // No markup: the agency price (AED 850) is what's compared, so a max of AED 900 keeps it.
  assert.equal(visibleRooms(rooms, { boardBasisId: null, refundableOnly: false, maxSellMinor: 90000 }).length, 1)
  // 20% markup: the displayed client price (AED 1,020) exceeds a max of AED 900, so it must drop out.
  assert.equal(visibleRooms(rooms, { boardBasisId: null, refundableOnly: false, maxSellMinor: 90000, markupBp: 2000 }).length, 0)
  // Raising the max to cover the displayed client price brings it back.
  assert.equal(visibleRooms(rooms, { boardBasisId: null, refundableOnly: false, maxSellMinor: 102000, markupBp: 2000 }).length, 1)
})

test('a room "from" price is the lowest instantly sellable total; on-request and sold-out never lead', () => {
  assert.deepEqual(roomFromMinor({ rates: [rate('a', 'ro', 70000), rate('b', 'ro', 40000, { availability: 'on_request' }), rate('c', 'ro', 30000, { availability: 'sold_out' }), rate('d', 'ro', 65000)] }), { amountMinor: 65000, currency: 'AED' })
  assert.equal(roomFromMinor({ rates: [rate('b', 'ro', 40000, { availability: 'on_request' })] }), null)
})
