import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { BookingService } from './booking-service.ts'

const original = globalThis.fetch
afterEach(() => { globalThis.fetch = original })
const reply = (status, body) => async () => new Response(JSON.stringify(body), { status })
const service = () => new BookingService('https://api.invalid', 1000)
const guest = { adults: 2, children: 0, childAges: [], firstName: ' Layla ', lastName: 'Hassan ' }

test('every call carries the tenant header and session credentials; prebook is idempotent per hold and trims names', async () => {
  let seen
  globalThis.fetch = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ success: true, data: { status: 'prebooked', bookingId: 'b1', bookingReference: 'FB-1' } }), { status: 201 }) }
  const result = await service().prebook('hold-1', guest, 'tenant-a')
  assert.deepEqual(result, { ok: true, data: { status: 'prebooked', bookingId: 'b1', bookingReference: 'FB-1' } })
  assert.equal(seen.url, 'https://api.invalid/agent/prebook'); assert.equal(seen.init.credentials, 'include'); assert.equal(seen.init.headers['x-fbeds-tenant-id'], 'tenant-a')
  assert.deepEqual(JSON.parse(seen.init.body), { inventoryHoldId: 'hold-1', idempotencyKey: 'prebook-hold-1', adults: 2, children: 0, childAges: [], leadGuest: { firstName: 'Layla', lastName: 'Hassan' } })
})

test('a disabled booking API is reported as unavailable, never as success', async () => {
  globalThis.fetch = reply(503, { success: true, data: { status: 'booking_unavailable', message: 'x' } })
  assert.deepEqual(await service().prebook('h', guest, 't'), { ok: false, kind: 'unavailable', message: 'Booking is not enabled for this workspace yet.' })
  assert.equal((await service().list('t')).kind, 'unavailable')
  const doc = await (async () => { globalThis.fetch = async () => new Response('Booking documents are unavailable.', { status: 503 }); return service().documentHtml('b', 'voucher', 't') })()
  assert.equal(doc.kind, 'unavailable')
})

test('HTTP failures map to explicit kinds; only conflict/invalid/gone show the server message', async () => {
  const cases = [[401, 'auth'], [403, 'denied'], [404, 'not_found'], [409, 'conflict'], [410, 'gone'], [400, 'invalid'], [500, 'error'], [503, 'error']]
  for (const [status, kind] of cases) {
    globalThis.fetch = reply(status, { success: false, error: { code: 'X', message: 'Insufficient wallet credit' } })
    const result = await service().confirm('b1', 't')
    assert.equal(result.ok, false); assert.equal(result.kind, kind)
    assert.equal(result.message.includes('Insufficient wallet credit'), ['conflict', 'invalid', 'gone'].includes(kind), `${status}`)
  }
  globalThis.fetch = reply(503, { success: false, error: { code: 'RECONCILIATION', message: 'Supplier outcome requires reconciliation' } })
  const ambiguous = await service().confirm('b1', 't')
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.message, 'Reconciliation required')
  globalThis.fetch = async () => { throw new Error('network') }
  assert.equal((await service().confirm('b1', 't')).kind, 'error')
  assert.equal((await new BookingService('', 10).confirm('b1', 't')).kind, 'error')
  assert.equal((await service().confirm('b1', '')).kind, 'error')
})

test('malformed success bodies are rejected instead of trusted', async () => {
  globalThis.fetch = reply(201, { data: { status: 'prebooked' } })
  assert.equal((await service().prebook('h', guest, 't')).ok, false)
  globalThis.fetch = reply(200, { data: [{ id: 'b', reference: 'r', status: 'CONFIRMED', currency: 'AED', totalMinor: '100' }] })
  assert.equal((await service().list('t')).ok, false)
  globalThis.fetch = reply(200, { data: { items: [{ id: 'b', reference: 'r', status: 'CONFIRMED', currency: 'AED', totalMinor: '100' }], total: 51, limit: 20, offset: 20 } })
  const page = await service().list('t', { limit: 20, offset: 20, status: 'CONFIRMED' })
  assert.equal(page.ok && page.data.total, 51)
  assert.equal(page.ok && page.data.items.length, 1)
  globalThis.fetch = reply(200, { data: { bookingId: 'b', currency: 'AED', totalMinor: '100', penaltyMinor: '30', refundMinor: 'x' } })
  assert.equal((await service().cancellationQuote('b', 't')).ok, false)
})

test('hold keeps meaningful non-2xx outcomes and exposes only validated fields', async () => {
  globalThis.fetch = reply(409, { success: true, data: { status: 'price_changed', currency: 'AED', sellAmountMinor: 130000, extra: 'ignored' } })
  assert.deepEqual(await service().hold('offer/1', 's1', 'AED', 125099, 'hold-12345678', 't'), { ok: true, data: { status: 'price_changed', currency: 'AED', sellAmountMinor: 130000 } })
  globalThis.fetch = reply(201, { data: { status: 'held', holdId: 'h1', expiresAt: '2099-01-01T00:00:00.000Z', currency: 'AED', sellAmountMinor: 125099 } })
  const held = await service().hold('o', 's', 'AED', 125099, 'hold-12345678', 't')
  assert.equal(held.ok && held.data.holdId, 'h1')
})

test('cancel and quote use the right verbs and paths, with exact string amounts', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push([url, init.method ?? 'GET']); return new Response(JSON.stringify({ data: { status: 'CANCELLED', bookingId: 'b/1', currency: 'AED', totalMinor: '125099', penaltyMinor: '37529', refundMinor: '87570', checkIn: '2099-03-01', evaluatedAt: 'x', alreadyCancelled: false, cancellationId: 'c1' } }), { status: 200 }) }
  const quote = await service().cancellationQuote('b/1', 't'); const done = await service().cancel('b/1', 'guest request', 't')
  assert.deepEqual(calls, [['https://api.invalid/agent/bookings/b%2F1/cancellation-quote', 'GET'], ['https://api.invalid/agent/bookings/b%2F1', 'DELETE']])
  assert.equal(quote.ok && quote.data.refundMinor, '87570'); assert.equal(done.ok && done.data.penaltyMinor, '37529')
})

test('document html returns the text only on success', async () => {
  globalThis.fetch = async () => new Response('<!doctype html><p>ok</p>', { status: 200, headers: { 'content-type': 'text/html' } })
  assert.deepEqual(await service().documentHtml('b', 'invoice', 't'), { ok: true, data: '<!doctype html><p>ok</p>' })
  globalThis.fetch = reply(409, { error: { message: 'A voucher is issued only for a confirmed booking' } })
  const refused = await service().documentHtml('b', 'voucher', 't')
  assert.equal(refused.ok, false); assert.equal(refused.message, 'A voucher is issued only for a confirmed booking')
})

test('releasing a hold uses DELETE on the hold and only trusts a RELEASED/EXPIRED answer', async () => {
  let seen
  globalThis.fetch = async (url, init) => { seen = [url, init.method, init.headers['x-fbeds-tenant-id']]; return new Response(JSON.stringify({ data: { holdId: 'h/1', status: 'RELEASED' } }), { status: 200 }) }
  assert.deepEqual(await service().releaseHold('h/1', 'tenant-a'), { ok: true, data: { holdId: 'h/1', status: 'RELEASED' } })
  assert.deepEqual(seen, ['https://api.invalid/agent/holds/h%2F1', 'DELETE', 'tenant-a'])
  globalThis.fetch = reply(200, { data: { holdId: 'h', status: 'HELD' } })
  assert.equal((await service().releaseHold('h', 't')).ok, false)
  globalThis.fetch = reply(409, { error: { message: 'Inventory hold can no longer be released' } })
  const refused = await service().releaseHold('h', 't')
  assert.equal(refused.ok, false); assert.equal(refused.kind, 'conflict'); assert.match(refused.message, /no longer be released/)
})
