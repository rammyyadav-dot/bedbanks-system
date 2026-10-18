import { test } from 'node:test'
import assert from 'node:assert/strict'
import { payAtHotelLines, priceIncludesText } from './pay-at-hotel.ts'

test('states each charge paid at the hotel with its stay estimate', () => {
  assert.deepEqual(payAtHotelLines({ payAtHotel: [{ kind: 'TOURISM_DIRHAM', label: 'Tourism Dirham', amountMinor: 2000, currency: 'AED', basis: 'PER_ROOM_PER_NIGHT', estimatedTotalMinor: 6000 }] }), ['Tourism Dirham AED 20.00 / room / night (about AED 60.00 for this stay)'])
  assert.deepEqual(payAtHotelLines({}), [])
})

test('says what the price includes, and nothing when the provider did not say', () => {
  assert.equal(priceIncludesText({ priceIncludes: { taxes: false, fees: false } }), 'Taxes and service fees not included in the price')
  assert.equal(priceIncludesText({ priceIncludes: { taxes: true, fees: true } }), 'Price includes taxes and service fees')
  assert.equal(priceIncludesText({}), null)
})
