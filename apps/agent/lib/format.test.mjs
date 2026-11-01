import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bookingReviewStay, creditBreakdown, formatCancellationDeadline, formatCompactStay, formatMinorAmount, formatMinorDelta, formatOfferExpiry, formatStay, recheckedTotalText, weekdayShort } from './format.ts'

test('formats integer minor units in the stated currency without floating point', () => {
  assert.equal(formatMinorAmount('125000000', 'USD'), 'USD 1,250,000.00')
  assert.equal(formatMinorAmount(245000, 'AED'), 'AED 2,450.00')
  assert.equal(formatMinorAmount(5n, 'AED'), 'AED 0.05')
  assert.equal(formatMinorAmount('9007199254740993123', 'USD'), 'USD 90,071,992,547,409,931.23')
})

test('handles zero-decimal currencies and overdrawn (negative) balances', () => {
  assert.equal(formatMinorAmount(1500, 'JPY'), 'JPY 1,500')
  assert.equal(formatMinorAmount('-2550', 'USD'), 'USD -25.50')
})

test('refuses to display anything that is not a safe integer amount with an ISO currency', () => {
  for (const amount of ['12.5', '', 'abc', '1e3', NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, null, undefined]) assert.equal(formatMinorAmount(amount, 'USD'), null)
  for (const currency of ['usd', 'US', 'USDD', '', null, undefined]) assert.equal(formatMinorAmount(100, currency), null)
})

test('formats a stay with nights and never shifts a day with the local time zone', () => {
  assert.equal(formatStay('2026-11-20', '2026-11-23'), '20 Nov – 23 Nov 2026 · 3 nights')
  assert.equal(formatStay('2026-12-30', '2027-01-02'), '30 Dec 2026 – 2 Jan 2027 · 3 nights')
  assert.equal(formatStay('2026-11-20', '2026-11-21'), '20 Nov – 21 Nov 2026 · 1 night')
})

test('formats a compact stay and a signed minor-unit difference', () => {
  assert.equal(formatCompactStay('2026-10-12', '2026-10-15'), '12–15 Oct')
  assert.equal(formatCompactStay('2026-12-30', '2027-01-02'), '30 Dec – 2 Jan')
  assert.equal(weekdayShort('2026-10-12'), 'Mon')
  assert.equal(formatMinorDelta(124500, 131000, 'AED'), '+AED 65.00')
  assert.equal(formatMinorDelta(131000, 124500, 'AED'), 'AED -65.00')
  assert.equal(formatMinorDelta(1.5, 2, 'AED'), null)
})

test('formats a cancellation deadline in the hotel time zone', () => {
  assert.equal(formatCancellationDeadline('2026-10-08T20:00:00.000Z', 'Asia/Dubai'), '00:00 on 9 Oct')
  assert.equal(formatCancellationDeadline('2026-10-12T14:00:00.000Z', 'Asia/Dubai'), '18:00 on 12 Oct')
  assert.equal(formatCancellationDeadline('not-a-date', 'Asia/Dubai'), null)
  assert.equal(formatCancellationDeadline('2026-10-12T14:00:00.000Z', ''), null)
})

test('falls back to the raw dates when they are invalid or out of order', () => {
  assert.equal(formatStay('2026-02-30', '2026-03-02'), '2026-02-30 – 2026-03-02')
  assert.equal(formatStay('2026-11-23', '2026-11-20'), '2026-11-23 – 2026-11-20')
  assert.equal(formatStay('', ''), ' – ')
})

test('derives credit used from limit and available using integers only', () => {
  assert.deepEqual(creditBreakdown({ currency: 'USD', availableCredit: '125000000', creditLimit: '150000000' }), { available: 'USD 1,250,000.00', limit: 'USD 1,500,000.00', used: 'USD 250,000.00' })
  assert.deepEqual(creditBreakdown({ currency: 'USD', availableCredit: '-500', creditLimit: '1000' }), { available: 'USD -5.00', limit: 'USD 10.00', used: 'USD 15.00' })
})

test('booking review shows the rechecked currency once', () => {
  const total = recheckedTotalText(60000, 'AED')
  assert.equal(total, 'AED 600.00')
  assert.equal(total.match(/AED/g)?.length, 1)
  assert.equal(recheckedTotalText(1.5, 'AED'), 'Price unavailable')
})

test('booking review stay includes the night count once', () => {
  const stay = bookingReviewStay('2026-10-09', '2026-10-12')
  assert.equal(stay, '9 Oct – 12 Oct 2026 · 3 nights')
  assert.equal(stay.match(/nights/g)?.length, 1)
})

test('never invents a figure that the API did not send', () => {
  assert.deepEqual(creditBreakdown({ currency: 'USD', availableCredit: '100' }), { available: 'USD 1.00', limit: null, used: null })
  assert.deepEqual(creditBreakdown({ availableCredit: '100', creditLimit: '200' }), { available: null, limit: null, used: null })
  assert.deepEqual(creditBreakdown(null), { available: null, limit: null, used: null })
  assert.deepEqual(creditBreakdown({ currency: 'USD', availableCredit: '1.5', creditLimit: 'x' }), { available: null, limit: null, used: null })
})

test('formats a server expiry in the hotel time zone and refuses anything that is not an instant', () => {
  assert.equal(formatOfferExpiry('2026-10-05T14:30:00.000Z', 'Asia/Dubai'), '5 Oct 2026, 18:30 (Asia/Dubai)')
  assert.equal(formatOfferExpiry('2026-10-05T14:30:00.000Z', 'Not/AZone'), '5 Oct 2026, 14:30 (UTC)')
  assert.equal(formatOfferExpiry('2026-10-05T14:30:00.000Z', undefined), '5 Oct 2026, 14:30 (UTC)')
  assert.equal(formatOfferExpiry('soon', 'Asia/Dubai'), null)
  assert.equal(formatOfferExpiry(undefined, 'Asia/Dubai'), null)
})
