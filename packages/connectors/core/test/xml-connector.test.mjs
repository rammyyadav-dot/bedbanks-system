import test from 'node:test'
import assert from 'node:assert/strict'
import {
  XmlSupplierTransport, XmlSupplierConnector, InProcessGate, SupplierCallError, assertSafeEndpoint, isPrivateAddress,
  el, xmlDocument, at, kids, requiredText, requiredAttr, supplierAmountMinor, evaluateReadiness, ProviderProfileRegistry, PROVIDER_ONBOARDING,
} from '../src/index.ts'

const scope = { tenantId: 'tenant-a', supplierId: 'supplier-a', connectorId: 'connector-a' }
const ctx = { ...scope, correlationId: 'corr-1' }
const SECRET = 'TOP-SECRET-PASSWORD-123'
const ENDPOINT = 'https://xml.fixture-supplier.example/api'
const xml = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/xml; charset=utf-8', ...headers } })
const publicHost = async () => ['93.184.216.34']
const query = { checkIn: '2027-03-01', checkOut: '2027-03-03', supplierHotelCodes: ['H1'], rooms: [{ adults: 2, childAges: [] }], currency: 'AED' }

/** A synthetic supplier used only to exercise the shared kit. It is NOT a real provider and is never registered. */
const fixtureProfile = {
  provider: 'fixture', profileVersion: '0.0.0-test', certification: 'FIXTURE_ONLY',
  capabilities: ['search', 'recheck', 'book', 'cancel', 'status'],
  faultOf(root) {
    if (root.name !== 'Error') return null
    const c = root.attrs.code ?? null
    return { code: c, kind: c === '401' ? 'authentication' : c === '429' ? 'quota' : c === '503' ? 'unavailable' : 'rejected' }
  },
  search: {
    build: (q, s) => ({ body: xmlDocument(el('Search', { user: s.user, password: s.password }, el('Stay', { in: q.checkIn, out: q.checkOut }))) }),
    parse: (root, q, receivedAt) => kids(root, 'Rate').map((r) => ({
      supplierHotelCode: requiredAttr(r, 'hotel'), supplierRoomCode: requiredAttr(r, 'room'), supplierRoomName: null, boardCode: r.attrs.board ?? null, roomIndex: 0,
      checkIn: q.checkIn, checkOut: q.checkOut, currency: requiredAttr(r, 'cur'), netMinor: supplierAmountMinor(requiredText(r, 'Net'), requiredAttr(r, 'cur')),
      refundable: null, cancellationPolicies: kids(r, 'Cancel').map((c) => ({ from: requiredAttr(c, 'from'), penaltyMinor: supplierAmountMinor(c.text, requiredAttr(r, 'cur'), true) })),
      taxesIncluded: null, rateToken: requiredAttr(r, 'token'), supplierExpiresAt: null, receivedAt: receivedAt.toISOString(),
    })),
  },
  book: {
    build: (b, s) => ({ body: xmlDocument(el('Book', { user: s.user, password: s.password, ref: b.reference, key: b.idempotencyKey })) }),
    parse: (root) => root.name === 'Booked' ? { outcome: 'CONFIRMED', supplierRef: root.attrs.ref ?? null, hotelConfirmationNo: null } : { outcome: 'REJECTED', code: 'x' },
  },
}
function connector(fetcher, extra = {}, profile = fixtureProfile, events = []) {
  const transport = new XmlSupplierTransport({ ...scope, enabled: true, endpoint: ENDPOINT, allowedHosts: ['xml.fixture-supplier.example'], secretRef: 'secret/fixture', ...extra }, {
    resolveSecret: async () => ({ user: 'u', password: SECRET }), fetch: fetcher, resolveHost: publicHost, sleep: async () => undefined, random: () => 0, event: (e) => events.push(e),
  })
  return new XmlSupplierConnector(profile, transport)
}
const goodRate = (extra = '') => `<Rates><Rate hotel="H1" room="DBL" cur="AED" token="t1" ${extra}><Net>412.50</Net><Cancel from="2027-02-20T00:00:00+04:00">100.00</Cancel></Rate></Rates>`
const fails = (code, delivery) => (e) => e instanceof SupplierCallError && e.code === code && (delivery === undefined || e.delivery === delivery) && !JSON.stringify(e).includes(SECRET) && !e.message.includes(SECRET)

test('search maps a supplier document to canonical integer-minor offers', async () => {
  const result = await connector(async () => xml(goodRate())).search(query, ctx)
  assert.equal(result.offers.length, 1)
  assert.equal(result.offers[0].netMinor, 41250); assert.equal(result.offers[0].currency, 'AED')
  assert.equal(result.offers[0].supplierExpiresAt, null); assert.equal(result.offers[0].taxesIncluded, null)
})
test('disabled by default and scope-locked', async () => {
  await assert.rejects(connector(async () => { throw Error('must not fetch') }, { enabled: false }).search(query, ctx), fails('disabled'))
  await assert.rejects(connector(async () => xml(goodRate())).search(query, { ...ctx, tenantId: 'tenant-b' }), fails('scope'))
})
test('endpoint is operator config: https, allowlisted host, no userinfo/ip/port/redirect', () => {
  const ok = ['xml.fixture-supplier.example']
  for (const bad of ['http://xml.fixture-supplier.example/a', 'https://evil.example/a', 'https://u:p@xml.fixture-supplier.example/a', 'https://xml.fixture-supplier.example:8443/a', 'https://10.0.0.1/a', 'https://[::1]/a', 'https://localhost/a', 'not a url']) {
    assert.throws(() => assertSafeEndpoint(bad, ok), fails('endpoint_rejected'), bad)
  }
  assert.ok(assertSafeEndpoint(ENDPOINT, ok))
  assert.equal(isPrivateAddress('169.254.169.254'), true); assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true); assert.equal(isPrivateAddress('93.184.216.34'), false)
})
test('a host that resolves to a private address is refused before any request', async () => {
  const transport = new XmlSupplierTransport({ ...scope, enabled: true, endpoint: ENDPOINT, allowedHosts: ['xml.fixture-supplier.example'], secretRef: 's' }, { resolveSecret: async () => ({}), fetch: async () => { throw Error('must not fetch') }, resolveHost: async () => ['169.254.169.254'] })
  await assert.rejects(new XmlSupplierConnector(fixtureProfile, transport).search(query, ctx), fails('endpoint_rejected'))
})
test('fetch uses redirect:error and never leaks credentials into events or errors', async () => {
  let init; const events = []
  await connector(async (_u, i) => { init = i; return xml(goodRate()) }, {}, fixtureProfile, events).search(query, ctx)
  assert.equal(init.redirect, 'error')
  assert.ok(init.body.includes(SECRET), 'builder receives the secret')
  assert.ok(!JSON.stringify(events).includes(SECRET)); assert.equal(events[0].outcome, 'success')
  const events2 = []
  await assert.rejects(connector(async () => xml('<Error code="401"/>'), {}, fixtureProfile, events2).search(query, ctx), fails('authentication'))
  assert.ok(!JSON.stringify(events2).includes(SECRET))
})
test('a read retries once on a transient fault; a persistent fault surfaces', async () => {
  let calls = 0
  const result = await connector(async () => { calls++; return calls === 1 ? xml('', 503) : xml(goodRate()) }).search(query, ctx)
  assert.equal(calls, 2); assert.equal(result.offers.length, 1)
  calls = 0
  await assert.rejects(connector(async () => { calls++; return xml('', 503) }).search(query, ctx), fails('provider_unavailable'))
  assert.equal(calls, 2)
})
test('a mutation is NEVER retried and a lost answer is reported as maybe_sent', async () => {
  const book = { reference: 'FB-1234567', idempotencyKey: 'idem-12345678', rateToken: 't1', currency: 'AED', expectedNetMinor: 41250, rooms: [{ guests: [{ title: null, firstName: 'A', lastName: 'B', isLead: true, age: null }] }] }
  let calls = 0
  await assert.rejects(connector(async () => { calls++; return xml('', 503) }).book(book, ctx), fails('provider_unavailable', 'maybe_sent'))
  await assert.rejects(connector(async () => { calls++; throw new TypeError('socket hang up') }).book(book, ctx), fails('transport', 'maybe_sent'))
  await assert.rejects(connector(async () => { calls++; return xml('<<not xml') }).book(book, ctx), fails('malformed_response', 'maybe_sent'))
  assert.equal(calls, 3)
  assert.deepEqual(await connector(async () => xml('<Booked ref="S-1"/>')).book(book, ctx), { outcome: 'CONFIRMED', supplierRef: 'S-1', hotelConfirmationNo: null })
  // Authentication rejection is a definite answer: nothing was booked.
  await assert.rejects(connector(async () => xml('', 401)).book(book, ctx), fails('authentication', 'answered'))
})
test('timeouts are classified and a mutation timeout is maybe_sent', async () => {
  const hang = (_u, i) => new Promise((_r, reject) => i.signal.addEventListener('abort', () => reject(new Error('aborted'))))
  const book = { reference: 'FB-1234567', idempotencyKey: 'idem-12345678', rateToken: 't1', currency: 'AED', expectedNetMinor: 1, rooms: [{ guests: [{ title: null, firstName: 'A', lastName: 'B', isLead: true, age: null }] }] }
  await assert.rejects(connector(hang, { attemptTimeoutMs: 20, overallTimeoutMs: 40 }).book(book, ctx), fails('timeout', 'maybe_sent'))
})
test('supplier faults map to classified errors, never to empty inventory', async () => {
  await assert.rejects(connector(async () => xml('<Error code="429"/>')).search(query, ctx), fails('quota_exhausted'))
  await assert.rejects(connector(async () => xml('<Error code="77"/>')).search(query, ctx), (e) => e.code === 'supplier_fault' && e.supplierCode === '77')
})
test('malformed or unsafe supplier data rejects the whole response (no partial inventory)', async () => {
  const cases = {
    float: goodRate().replace('412.50', '4.1e2'), zero: goodRate().replace('412.50', '0.00'), negative: goodRate().replace('412.50', '-1.00'), excess: goodRate().replace('412.50', '412.505'),
    currency: goodRate().replace('cur="AED"', 'cur="USD"'), unknownHotel: goodRate().replace('hotel="H1"', 'hotel="H9"'), bareLocalTime: goodRate().replace('2027-02-20T00:00:00+04:00', '2027-02-20 00:00'),
    duplicateToken: `<Rates>${goodRate().slice(7, -8)}${goodRate().slice(7, -8)}</Rates>`, doctype: '<!DOCTYPE a [<!ENTITY x "y">]><Rates/>',
  }
  for (const [name, body] of Object.entries(cases)) await assert.rejects(connector(async () => xml(body)).search(query, ctx), fails('malformed_response'), name)
  await assert.rejects(connector(async () => new Response(goodRate(), { headers: { 'content-type': 'application/json' } })).search(query, ctx), fails('malformed_response'))
  await assert.rejects(connector(async () => new Response(goodRate(), { headers: { 'content-type': 'text/xml; charset=iso-8859-1' } })).search(query, ctx), fails('malformed_response'))
  await assert.rejects(connector(async () => xml(goodRate()), { maxResponseBytes: 10 }).search(query, ctx), fails('malformed_response'))
})
test('empty inventory is a valid answer, an error is not', async () => {
  assert.deepEqual((await connector(async () => xml('<Rates/>')).search(query, ctx)).offers, [])
})
test('unsupported capability and bad queries fail before any request', async () => {
  const noFetch = async () => { throw Error('must not fetch') }
  await assert.rejects(connector(noFetch, {}, { ...fixtureProfile, capabilities: ['search'] }).cancel({ reference: 'FB-1234', supplierRef: null, idempotencyKey: 'idem-12345678' }, ctx), fails('unsupported', 'not_sent'))
  for (const bad of [{ ...query, checkOut: query.checkIn }, { ...query, supplierHotelCodes: [] }, { ...query, rooms: [{ adults: 0, childAges: [] }] }, { ...query, currency: 'aed' }, { ...query, checkIn: '2027-02-30' }]) {
    await assert.rejects(connector(noFetch).search(bad, ctx), fails('unsupported', 'not_sent'))
  }
})
test('header injection from a profile is refused', async () => {
  const bad = { ...fixtureProfile, search: { ...fixtureProfile.search, build: () => ({ body: '<a/>', headers: { SOAPAction: 'x\r\nHost: evil' } }) } }
  await assert.rejects(connector(async () => xml(goodRate()), {}, bad).search(query, ctx), fails('configuration'))
})
test('circuit opens after repeated provider failures and does not call the supplier', async () => {
  let calls = 0
  const gate = new InProcessGate({ failureThreshold: 2, openMs: 60_000 })
  const transport = new XmlSupplierTransport({ ...scope, enabled: true, endpoint: ENDPOINT, allowedHosts: ['xml.fixture-supplier.example'], secretRef: 's' }, { resolveSecret: async () => ({ user: 'u', password: 'p' }), fetch: async () => { calls++; return xml('', 503) }, resolveHost: publicHost, sleep: async () => undefined, random: () => 0, gate })
  const c = new XmlSupplierConnector(fixtureProfile, transport)
  await assert.rejects(c.search(query, ctx), fails('provider_unavailable'))
  await assert.rejects(c.search(query, ctx), fails('provider_unavailable'))
  const before = calls
  await assert.rejects(c.search(query, ctx), fails('circuit_open', 'not_sent'))
  assert.equal(calls, before); assert.equal(gate.snapshot().circuitOpen, true)
})
test('secret resolution failure is classified without leaking', async () => {
  const transport = new XmlSupplierTransport({ ...scope, enabled: true, endpoint: ENDPOINT, allowedHosts: ['xml.fixture-supplier.example'], secretRef: 's' }, { resolveSecret: async () => { throw new Error(SECRET) }, fetch: async () => { throw Error('no') }, resolveHost: publicHost })
  await assert.rejects(new XmlSupplierConnector(fixtureProfile, transport).search(query, ctx), fails('secret_unavailable'))
})
test('money parsing is exact and rejects floats', () => {
  assert.equal(supplierAmountMinor('0.05', 'AED'), 5); assert.equal(supplierAmountMinor('1', 'KWD'), 1000); assert.equal(supplierAmountMinor('0', 'AED', true), 0)
  for (const bad of ['1e3', '1,000.00', ' ', '', '-1', '1.234', undefined, 12.5]) assert.throws(() => supplierAmountMinor(bad, 'AED'), SupplierCallError)
})
test('readiness: unimplemented suppliers are never searchable or bookable', () => {
  const allTrue = { active: true, hasCredentialReference: true, secretResolverBound: true, endpointAllowlisted: true, sharedGateBound: true, governedMappingsPresent: true, executionAuditWired: true }
  for (const p of PROVIDER_ONBOARDING) {
    const report = evaluateReadiness(p.provider, null, allTrue)
    assert.equal(report.searchable, false); assert.equal(report.bookable, false); assert.equal(report.certification, 'NOT_IMPLEMENTED')
    assert.ok(p.requiredFromSupplier.length > 5)
  }
  assert.deepEqual(PROVIDER_ONBOARDING.map((p) => p.provider), ['webbeds', 'tbo', 'darina'])
  const fixtureReport = evaluateReadiness('fixture', fixtureProfile, allTrue)
  assert.equal(fixtureReport.searchable, false, 'FIXTURE_ONLY profiles are never sellable')
  const prod = evaluateReadiness('fixture', { ...fixtureProfile, certification: 'PRODUCTION_CERTIFIED' }, allTrue)
  assert.equal(prod.searchable, true); assert.equal(prod.bookable, true)
  assert.equal(evaluateReadiness('fixture', { ...fixtureProfile, certification: 'PRODUCTION_CERTIFIED' }, { ...allTrue, sharedGateBound: false }).searchable, false)
})
test('registry resolves only explicitly registered profiles', () => {
  const r = new ProviderProfileRegistry()
  assert.equal(r.get('webbeds'), null); r.register(fixtureProfile); assert.equal(r.get('fixture'), fixtureProfile)
  assert.throws(() => r.register(fixtureProfile)); assert.throws(() => r.register({ ...fixtureProfile, provider: 'Bad Name' }))
})
