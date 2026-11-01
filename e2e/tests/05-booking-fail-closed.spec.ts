import { expect, test } from '@playwright/test'
import { ORIGINS } from '../support/config'
import { call, login, offerSearchBody, SELLABLE_STAY } from '../support/api'
import { fixtures } from '../support/helpers'
import { moneyAndBookingCounts } from '../support/stack'

test.describe('Booking and payments stay closed (no hold, no booking, no money moves)', () => {
  test('B1 the workspace reports booking as disabled', async () => {
    const { cookie } = await login('agent')
    const ctx = await call('/agent/context', { cookie })
    expect(ctx.body.data.bookingEnabled).toBe(false)
  })

  test('B2 holding an offer and prebooking answer 503 booking_unavailable, never 2xx', async () => {
    const f = fixtures()
    const { cookie } = await login('agent')
    const headers = { 'x-fbeds-tenant-id': f.tenantA }
    const stay = SELLABLE_STAY()
    const search = await call('/agent/search', { cookie, headers, json: offerSearchBody(stay.checkIn, stay.checkOut) })
    const rate = search.body.data.hotels[0].rooms[0].rates[0]

    const before = moneyAndBookingCounts()
    const hold = await call(`/agent/offers/${encodeURIComponent(rate.offerId)}/hold`, {
      cookie, headers, origin: ORIGINS.agent,
      json: { searchId: search.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: rate.sellAmountMinor, idempotencyKey: 'e2e-hold-0000001' },
    })
    expect(hold.status).toBe(503)
    expect(hold.body.data?.status ?? hold.body.status).toBe('booking_unavailable')

    const prebook = await call('/agent/prebook', {
      cookie, headers, origin: ORIGINS.agent,
      json: { inventoryHoldId: 'does-not-exist', idempotencyKey: 'e2e-prebook-000001', adults: 2, children: 0, childAges: [], leadGuest: { firstName: 'Test', lastName: 'Guest' } },
    })
    expect(prebook.status).toBe(503)
    expect(prebook.body.data?.status ?? prebook.body.status).toBe('booking_unavailable')
    // Nothing was created or moved: no hold, no booking, no ledger entry, no finance event.
    expect(moneyAndBookingCounts()).toEqual(before)
  })

  test('B3 a recheck is read-only: the offer is confirmed at the same integer price and nothing is held', async () => {
    const f = fixtures()
    const { cookie } = await login('agent')
    const headers = { 'x-fbeds-tenant-id': f.tenantA }
    const stay = SELLABLE_STAY()
    const search = await call('/agent/search', { cookie, headers, json: offerSearchBody(stay.checkIn, stay.checkOut) })
    const rate = search.body.data.hotels[0].rooms[0].rates[0]
    const before = moneyAndBookingCounts()
    expect(Number.isInteger(rate.sellAmountMinor)).toBe(true)
    expect(rate.total.currency).toBe('AED')
    const rc = await call('/agent/rates/recheck', { cookie, headers, origin: ORIGINS.agent, json: { offerId: rate.offerId, searchId: search.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: rate.sellAmountMinor } })
    expect(rc.status).toBe(200)
    expect(rc.body.data?.status ?? rc.body.status).toBe('rechecked')
    expect(moneyAndBookingCounts()).toEqual(before)
  })

  test('B4 a price that does not match the quote is not silently accepted', async () => {
    const f = fixtures()
    const { cookie } = await login('agent')
    const headers = { 'x-fbeds-tenant-id': f.tenantA }
    const stay = SELLABLE_STAY()
    const search = await call('/agent/search', { cookie, headers, json: offerSearchBody(stay.checkIn, stay.checkOut) })
    const rate = search.body.data.hotels[0].rooms[0].rates[0]
    const rc = await call('/agent/rates/recheck', { cookie, headers, origin: ORIGINS.agent, json: { offerId: rate.offerId, searchId: search.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: rate.sellAmountMinor - 1 } })
    const status = rc.body.data?.status ?? rc.body.status
    expect(status).toBe('price_changed')
    expect(rc.status).toBe(409)
  })
})
