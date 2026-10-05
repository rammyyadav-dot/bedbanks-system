import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { HotelbedsSandboxTransport, hotelbedsAedMinor, normalizeHotelbedsResponse, retryAfter, validateSandboxSearch } from '../src/hotelbeds-sandbox.ts'
import { syncHotelbedsContent } from '../src/hotelbeds-content-sync.ts'

const scope = { tenantId: 'tenant-a', supplierId: 'supplier-a', connectorId: 'connector-a' }
const context = { ...scope, correlationId: 'request-a' }
const criteria = { checkIn: '2027-01-01', checkOut: '2027-01-02', rooms: 1, adults: 2, children: 0, hotelCodes: [3424] }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
function client(fetcher, extra = {}) {
  return new HotelbedsSandboxTransport({ ...scope, enabled: true, secretRef: 'hotelbeds-evaluation', ...extra }, {
    resolveSecret: async () => ({ apiKey: 'fixture-key', secret: 'fixture-secret' }), fetch: fetcher,
  })
}
const error = code => e => e.code === code && e.message === 'Supplier sandbox operation failed'
function response(rateChanges = {}, hotelChanges = {}) {
  return { hotels: { hotels: [{ code: 3424, currency: 'AED', rooms: [{ code: 'DBL.ST', rates: [{
    rateKey: 'fixture-key-do-not-log', rateType: 'RECHECK', net: '118.27', boardCode: 'BB',
    rooms: 1, adults: 2, children: 0, packaging: false, paymentType: 'AT_WEB',
    cancellationPolicies: [{ amount: '118.27', from: '2027-01-01T00:00:00+04:00' }],
    taxes: { allIncluded: true, taxes: [{ included: true, amount: '6.69', currency: 'AED' }] },
    ...rateChanges,
  }] }], ...hotelChanges }] } }
}

test('disabled default denies even a valid status request without resolving secrets', async () => {
  await assert.rejects(client(() => { throw Error('must not fetch') }, { enabled: false }).status(context), error('disabled'))
})
test('wrong tenant/supplier/connector/request scope denied', async () => {
  const c = client(() => { throw Error('must not fetch') })
  for (const patch of [{ tenantId: 'tenant-b' }, { supplierId: 'supplier-b' }, { connectorId: 'other' }, { correlationId: '../x' }]) {
    await assert.rejects(c.status({ ...context, ...patch }), error('scope'))
  }
})
test('fixed sandbox host, signature and redirect denial', async () => {
  let call
  const c = client(async (url, init) => { call = { url, init }; return json({ status: 'ok' }) })
  const before = Math.floor(Date.now() / 1000)
  await c.status(context)
  assert.equal(call.url, 'https://api.test.hotelbeds.com/hotel-api/1.0/status')
  assert.equal(call.init.redirect, 'error')
  const signatures = [before, Math.floor(Date.now() / 1000)].map(t => createHash('sha256').update('fixture-keyfixture-secret' + t).digest('hex'))
  assert.ok(signatures.includes(call.init.headers['X-Signature']))
  assert.deepEqual(c.health().capabilitiesSucceeded, ['status'])
  assert.equal(c.searchBooking, undefined)
  assert.equal(c.book, undefined)
  assert.equal(c.cancel, undefined)
})
test('canonical narrow search is serialized faithfully', async () => {
  let body
  await client(async (_, init) => { body = JSON.parse(init.body); return json(response()) }).search(criteria, context)
  assert.deepEqual(body, { stay: { checkIn: criteria.checkIn, checkOut: criteria.checkOut }, occupancies: [{ rooms: 1, adults: 2, children: 0 }], hotels: { hotel: [3424] } })
})
test('unsupported dates occupancy and hotel codes fail before transport', () => {
  for (const patch of [{ checkIn: '2027-02-30' }, { checkOut: '2026-12-31' }, { adults: 3 }, { children: 1 }, { rooms: 2 }, { hotelCodes: [] }, { hotelCodes: [1, 1] }, { hotelCodes: [-1] }]) {
    assert.throws(() => validateSandboxSearch({ ...criteria, ...patch }), error('unsupported'))
  }
})
test('only RECHECK uses checkrates; unsafe mutation operations do not exist', async () => {
  let call
  const c = client(async (url, init) => { call = { url, init }; return json({ hotel: {} }) })
  assert.throws(() => c.checkRate('fixture', 'BOOKABLE', context), error('unsupported'))
  await c.checkRate('fixture', 'RECHECK', context)
  assert.equal(call.url, 'https://api.test.hotelbeds.com/hotel-api/1.0/checkrates')
  assert.deepEqual(JSON.parse(call.init.body), { rooms: [{ rateKey: 'fixture' }] })
})
test('HTTP errors are sanitized; POST is not automatically retried', async () => {
  for (const [status, code] of [[401, 'authentication_or_quota'], [403, 'authentication_or_quota'], [429, 'rate_limited'], [503, 'provider_unavailable'], [400, 'unsupported']]) {
    let calls = 0
    await assert.rejects(client(async () => { calls++; return new Response('secret upstream details', { status }) }).search(criteria, context), error(code))
    assert.equal(calls, 1)
  }
})
test('GET retries once for transient failure and never retries credentials', async () => {
  let calls = 0
  await client(async () => ++calls === 1 ? new Response('', { status: 503 }) : json({ status: 'ok' })).status(context)
  assert.equal(calls, 2)
  calls = 0
  await assert.rejects(client(async () => { calls++; return new Response('', { status: 401 }) }).status(context), error('authentication_or_quota'))
  assert.equal(calls, 1)
})
test('excessive Retry-After does not cause an early retry', async () => {
  let calls = 0
  const c = client(async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '60' } }) })
  await assert.rejects(c.status(context), e => e.code === 'rate_limited' && e.retryAfterMs === 60000)
  assert.equal(calls, 1)
})
test('network exception text does not escape', async () => {
  await assert.rejects(client(async () => { throw Error('fixture-key fixture-secret') }).search(criteria, context), error('transport'))
})
test('invalid JSON, MIME, null, invalid UTF8 and oversized response rejected', async () => {
  for (const make of [
    () => new Response('not JSON', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    () => json(null),
    () => new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '3000000' } }),
    () => new Response(' '.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
  ]) await assert.rejects(client(async () => make()).status(context), error('malformed_response'))
})
test('caller cancellation fails closed before fetch', async () => {
  const signal = AbortSignal.abort()
  await assert.rejects(client(() => { throw Error('must not fetch') }).status({ ...context, signal }), error('cancelled'))
})
test('single-process concurrency refuses overlapping execution', async () => {
  let finish
  const c = client(() => new Promise(resolve => { finish = () => resolve(json({ status: 'ok' })) }))
  const first = c.status(context)
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(c.status(context), error('busy'))
  finish()
  await first
})
test('telemetry contains only classification and operational timing', async () => {
  const events = []
  const c = new HotelbedsSandboxTransport({ ...scope, enabled: true, secretRef: 'fixture' }, {
    resolveSecret: async () => ({ apiKey: 'fixture-key', secret: 'fixture-secret' }),
    fetch: async () => json({ status: 'ok' }), event: e => events.push(e),
  })
  await c.status(context)
  assert.deepEqual(Object.keys(events[0]).sort(), ['attempt', 'durationMs', 'operation', 'outcome'])
})
test('exact decimal conversion refuses floats and unsafe or zero amounts', () => {
  assert.equal(hotelbedsAedMinor('118.27'), 11827)
  assert.equal(hotelbedsAedMinor('1.1'), 110)
  for (const invalid of [118.27, '0', '-1.00', '1.001', '1e3', '01.00', '99999999999999.99', NaN]) assert.throws(() => hotelbedsAedMinor(invalid))
})
test('normalization stages supplier identities, never sellable offers or invented expiry', () => {
  const [o] = normalizeHotelbedsResponse(response(), '2026-10-05T00:00:00Z')
  assert.equal(o.netAmountMinor, 11827)
  assert.equal(o.selectable, false)
  assert.equal(o.supplierHotelId, '3424')
  assert.equal(o.supplierExpiresAt, null)
  assert.equal(o.supplierUpdatedAt, null)
  assert.equal(o.allTaxesIncluded, true)
  assert.ok(o.blockReasons.includes('sandbox_mapping_prohibited'))
  assert.equal(o.canonicalHotelId, undefined)
})
test('unknown or exclusive taxes are explicitly blocked', () => {
  for (const taxes of [undefined, { allIncluded: false, taxes: [] }, { allIncluded: true, taxes: [{ included: false, currency: 'AED', amount: '1' }] }]) {
    const [o] = normalizeHotelbedsResponse(response({ taxes }), '2026-10-05T00:00:00Z')
    assert.equal(o.allTaxesIncluded, false)
    assert.ok(o.blockReasons.includes('tax_inclusivity_unproven'))
  }
})
test('unsupported currency, rate type and occupancy fail closed', () => {
  for (const payload of [response({}, { currency: 'USD' }), response({ rateType: 'ON_REQUEST' }), response({ adults: 3 }), response({ packaging: true }), response({ paymentType: 'AT_HOTEL' })]) assert.throws(() => normalizeHotelbedsResponse(payload, new Date().toISOString()))
})
test('missing cancellation or board metadata never synthesized', () => {
  for (const patch of [{ cancellationPolicies: [] }, { boardCode: undefined }, { net: 118.27 }]) assert.throws(() => normalizeHotelbedsResponse(response(patch), new Date().toISOString()))
})
test('checkrate response shape normalized independently', () => {
  const payload = { hotel: response().hotels.hotels[0] }
  assert.equal(normalizeHotelbedsResponse(payload, new Date().toISOString()).length, 1)
})
test('Retry-After supports seconds and absolute dates', () => {
  assert.equal(retryAfter('2', 0), 2000)
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:00:03 GMT', 0), 3000)
  assert.equal(retryAfter('invalid', 0), null)
})

function syncFixture() {
  let checkpoint = 1
  const commits = []
  const coordination = { acquire: async key => ({ key, token: 'fixture-lease' }), release: async () => {} }
  const store = {
    checkpoint: async () => checkpoint,
    commitPage: async (_, input) => {
      assert.equal(input.expectedFrom, checkpoint)
      commits.push(input)
      checkpoint = input.nextFrom
    },
  }
  return { store, coordination, commits }
}
test('bounded content sync commits checkpoints and resumes without duplicate page', async () => {
  const f = syncFixture()
  const calls = []
  const transport = { contentPage: async from => { calls.push(from); return { from, to: from + 99, total: 200, hotels: [{ code: from }] } } }
  const first = await syncHotelbedsContent(transport, f.store, f.coordination, context, { runId: 'run-a', maxPages: 1 })
  assert.equal(first.complete, false)
  const second = await syncHotelbedsContent(transport, f.store, f.coordination, context, { runId: 'run-a', maxPages: 1 })
  assert.equal(second.complete, true)
  assert.deepEqual(calls, [1, 101])
  assert.equal(f.commits.length, 2)
})
test('failed page does not advance checkpoint; retry resumes failed page', async () => {
  const f = syncFixture()
  const failed = { contentPage: async () => { throw Error('fixture outage') } }
  await assert.rejects(syncHotelbedsContent(failed, f.store, f.coordination, context, { runId: 'run-a', maxPages: 1 }))
  assert.equal(await f.store.checkpoint(), 1)
  assert.equal(f.commits.length, 0)
})
test('missing coordination cannot silently proceed', async () => {
  const f = syncFixture()
  await assert.rejects(syncHotelbedsContent({}, f.store, { acquire: async () => null, release: async () => {} }, context, { runId: 'run-a', maxPages: 1 }))
})
test('malformed content pagination does not commit', async () => {
  const f = syncFixture()
  await assert.rejects(syncHotelbedsContent({ contentPage: async () => ({ from: 2, to: 101, total: 200, hotels: [] }) }, f.store, f.coordination, context, { runId: 'run-a', maxPages: 1 }))
  assert.equal(f.commits.length, 0)
})
test('content operation bounded and fixed to static-content endpoint', async () => {
  let url
  await client(async u => { url = u; return json({ hotels: [] }) }).contentPage(1, 100, context, '2026-10-05')
  assert.ok(url.startsWith('https://api.test.hotelbeds.com/hotel-content-api/1.0/hotels?'))
  assert.ok(url.includes('lastUpdateTime=2026-10-05'))
  assert.throws(() => client(() => {}).contentPage(1, 1000, context), error('unsupported'))
})


test('runtime operation guard also denies attempts to reach booking paths', async () => {
  const c = client(() => { throw Error('must not fetch') })
  await assert.rejects(c.request('search', 'POST', '/hotel-api/1.0/bookings', context, {}), error('unsupported'))
  await assert.rejects(c.request('content', 'GET', '//api.hotelbeds.com/bookings', context), error('unsupported'))
})
test('circuit opens after three failures and rejects subsequent calls', async () => {
  let now = Date.now(), calls = 0
  const c = new HotelbedsSandboxTransport({ ...scope, enabled: true, secretRef: 'fixture' }, {
    now: () => now, resolveSecret: async () => ({ apiKey: 'fixture-key', secret: 'fixture-secret' }),
    fetch: async () => { calls++; return new Response('', { status: 503 }) },
  })
  for (let i = 0; i < 3; i++) {
    await assert.rejects(c.search(criteria, context), error('provider_unavailable'))
    now += 1000
  }
  await assert.rejects(c.search(criteria, context), error('circuit_open'))
  assert.equal(calls, 3)
})
test('50 request per UTC day evaluation ceiling includes all operations', async () => {
  let now = Date.now(), calls = 0
  const c = new HotelbedsSandboxTransport({ ...scope, enabled: true, secretRef: 'fixture' }, {
    now: () => now, resolveSecret: async () => ({ apiKey: 'fixture-key', secret: 'fixture-secret' }),
    fetch: async () => { calls++; return json({ status: 'ok' }) },
  })
  for (let i = 0; i < 50; i++) { await c.status(context); now += 1000 }
  await assert.rejects(c.status(context), error('rate_limited'))
  assert.equal(calls, 50)
})
test('cancellation while waiting for transport is sanitized and releases concurrency', async () => {
  const controller = new AbortController()
  const c = client(async (_, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Error('raw secret')), { once: true })
  }))
  const result = c.search(criteria, { ...context, signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(result, error('cancelled'))
})
test('duplicate content identities cannot advance checkpoint', async () => {
  const f = syncFixture()
  await assert.rejects(syncHotelbedsContent({ contentPage: async () => ({ from: 1, to: 100, total: 200, hotels: [{ code: 1 }, { code: 1 }] }) }, f.store, f.coordination, context, { runId: 'run-a', maxPages: 1 }))
  assert.equal(f.commits.length, 0)
})
