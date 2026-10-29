import test from 'node:test'
import assert from 'node:assert/strict'
import { HotelbedsSandboxTransport } from '../src/hotelbeds-sandbox.ts'
import { buildHotelbedsBookBody, findHotelbedsBooking, hotelbedsClientReference, normalizeHotelbedsBooking } from '../src/hotelbeds-booking.ts'

const scope = { tenantId: 'tenant-a', supplierId: 'supplier-a', connectorId: 'connector-a' }
const context = { ...scope, correlationId: 'request-a' }
const REF = 'FB-0123456789ABCDEF0123'
const CLIENT = '0123456789ABCDEF0123'
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const inputs = { rateKey: 'fixture-rate-key-do-not-log', holder: { name: 'Amal', surname: 'Haddad' }, guests: [{ type: 'AD', name: 'Amal', surname: 'Haddad' }, { type: 'AD', name: 'Sam', surname: "O'Neil" }] }
/** Manual clock: each upstream call takes two seconds, so the one-request-per-second pacing never sleeps and the retry budget is realistic. */
function client(fetcher, extra = {}, event) {
  let t = Date.now()
  return new HotelbedsSandboxTransport({ ...scope, enabled: true, bookingEnabled: true, secretRef: 'hotelbeds-evaluation', ...extra }, {
    resolveSecret: async () => ({ apiKey: 'fixture-key', secret: 'fixture-secret' }), fetch: async (...args) => { t += 2000; return fetcher(...args) }, now: () => t, event,
  })
}
const code = c => e => e.code === c && e.message === 'Supplier sandbox operation failed'
const confirmed = (extra = {}) => ({ booking: { reference: '1-4135098', clientReference: CLIENT, status: 'CONFIRMED', totalNet: '118.27', currency: 'AED', ...extra } })

test('booking operations are denied unless bookingEnabled, before any secret or network use', async () => {
  const c = client(() => { throw Error('must not fetch') }, { bookingEnabled: undefined })
  const body = buildHotelbedsBookBody(REF, inputs)
  await assert.rejects(c.book(body, context), code('disabled'))
  await assert.rejects(c.cancelBooking('1-4135098', context), code('disabled'))
  await assert.rejects(c.findBookings(CLIENT, '2027-01-01', '2027-01-02', context), code('disabled'))
})
test('book posts the faithful body to the fixed test host and is never retried', async () => {
  let calls = []
  const c = client(async (url, init) => { calls.push({ url, init }); return calls.length ? new Response('', { status: 503 }) : json({}) })
  await assert.rejects(c.book(buildHotelbedsBookBody(REF, inputs), context), code('provider_unavailable'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.test.hotelbeds.com/hotel-api/1.0/bookings')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    holder: { name: 'Amal', surname: 'Haddad' }, clientReference: CLIENT, tolerance: 0,
    rooms: [{ rateKey: inputs.rateKey, paxes: [{ roomId: 1, type: 'AD', name: 'Amal', surname: 'Haddad' }, { roomId: 1, type: 'AD', name: 'Sam', surname: "O'Neil" }] }],
  })
})
test('cancel is a real-flag DELETE with no retry; simulation and path tricks are refused locally', async () => {
  const calls = []
  const c = client(async (url, init) => { calls.push({ url, init }); return new Response('', { status: 502 }) })
  await assert.rejects(c.cancelBooking('1-4135098', context), code('provider_unavailable'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.test.hotelbeds.com/hotel-api/1.0/bookings/1-4135098?cancellationFlag=CANCELLATION')
  assert.equal(calls[0].init.method, 'DELETE')
  for (const bad of ['', '../status', '1-4135098?x=1', 'a/b', 'x'.repeat(41)]) assert.throws(() => c.cancelBooking(bad, context), code('unsupported'))
})
test('lookup by client reference is a GET and retries one transient failure', async () => {
  const calls = []
  const c = client(async (url) => { calls.push(url); return calls.length === 1 ? new Response('', { status: 503 }) : json({ bookings: { bookings: [] } }) })
  await c.findBookings(CLIENT, '2027-01-01', '2027-01-31', context)
  assert.equal(calls.length, 2)
  assert.equal(calls[1], `https://api.test.hotelbeds.com/hotel-api/1.0/bookings?start=2027-01-01&end=2027-01-31&filterType=CREATION&clientReference=${CLIENT}&from=1&to=25`)
  for (const [ref, s, e] of [['bad ref', '2027-01-01', '2027-01-02'], [CLIENT, '2027-02-30', '2027-03-01'], [CLIENT, '2027-01-02', '2027-01-01']]) assert.throws(() => c.findBookings(ref, s, e, context), code('unsupported'))
})
test('book body validation refuses unsafe names, wrong tolerance and child ages before transport', async () => {
  const c = client(() => { throw Error('must not fetch') })
  const good = buildHotelbedsBookBody(REF, inputs)
  const bad = [
    { ...good, tolerance: 2 }, { ...good, clientReference: 'lower-case' },
    { ...good, holder: { name: 'A\nB', surname: 'C' } }, { ...good, holder: { name: '<script>', surname: 'C' } },
    { ...good, rooms: [{ rateKey: 'k\nx', paxes: good.rooms[0].paxes }] }, { ...good, rooms: [{ rateKey: 'k', paxes: [] }] },
    { ...good, rooms: [{ rateKey: 'k', paxes: [{ roomId: 1, type: 'CH', name: 'Kid', surname: 'X' }] }] },
    { ...good, rooms: [{ rateKey: 'k', paxes: [{ roomId: 1, type: 'AD', age: 30, name: 'Ad', surname: 'X' }] }] },
  ]
  for (const body of bad) assert.throws(() => c.book(body, context), code('unsupported'))
})
test('building a body validates it, so unsafe guest data never leaves the caller', () => {
  assert.throws(() => buildHotelbedsBookBody(REF, { ...inputs, holder: { name: '<b>', surname: 'X' } }), code('unsupported'))
  assert.throws(() => buildHotelbedsBookBody('FB-bad', inputs), code('unsupported'))
})
test('client reference is a lossless 20 character key of our FB- reference only', () => {
  assert.equal(hotelbedsClientReference(REF), CLIENT)
  for (const r of ['0123456789ABCDEF0123', 'FB-short', 'FB-0123456789abcdef0123', 'FB-0123456789ABCDEF01234']) assert.throws(() => hotelbedsClientReference(r), code('unsupported'))
})
test('booking response is parsed with exact minor units and strict status', () => {
  const f = normalizeHotelbedsBooking(confirmed())
  assert.deepEqual(f, { state: 'CONFIRMED', supplierRef: '1-4135098', clientReference: CLIENT, totalNetMinor: 11827 })
  assert.equal(normalizeHotelbedsBooking(confirmed({ status: 'CANCELLED', totalNet: '0.00' })).totalNetMinor, null)
  for (const payload of [null, {}, confirmed({ status: 'PENDING' }), confirmed({ totalNet: 118.27 }), confirmed({ totalNet: '0' }), confirmed({ currency: 'USD' }), confirmed({ reference: '../x' }), confirmed({ clientReference: 'bad ref' })]) {
    assert.throws(() => normalizeHotelbedsBooking(payload), code('malformed_response'))
  }
})
test('lookup distinguishes none held from a match and refuses ambiguity', () => {
  const entry = (clientReference, status = 'CONFIRMED', reference = '1-1') => ({ reference, clientReference, status })
  assert.equal(findHotelbedsBooking({ bookings: { bookings: [] } }, CLIENT), null)
  assert.equal(findHotelbedsBooking({ bookings: {} }, CLIENT), null)
  assert.equal(findHotelbedsBooking({ bookings: { bookings: [entry('OTHERREF')] } }, CLIENT), null)
  assert.equal(findHotelbedsBooking({ bookings: { bookings: [entry('OTHERREF'), entry(CLIENT, 'CANCELLED', '1-2')] } }, CLIENT).supplierRef, '1-2')
  assert.throws(() => findHotelbedsBooking({ bookings: { bookings: [entry(CLIENT), entry(CLIENT, 'CONFIRMED', '1-3')] } }, CLIENT), code('malformed_response'))
  assert.throws(() => findHotelbedsBooking({ bookings: { bookings: 'x' } }, CLIENT), code('malformed_response'))
  assert.throws(() => findHotelbedsBooking({}, CLIENT), code('malformed_response'))
})
test('telemetry for booking operations carries no body, guest or rate key', async () => {
  const events = []
  const c = client(async () => json(confirmed()), {}, e => events.push(e))
  await c.book(buildHotelbedsBookBody(REF, inputs), context)
  assert.deepEqual(Object.keys(events[0]).sort(), ['attempt', 'durationMs', 'operation', 'outcome'])
  assert.equal(events[0].operation, 'book')
  assert.ok(!JSON.stringify(events).includes('Haddad'))
})
