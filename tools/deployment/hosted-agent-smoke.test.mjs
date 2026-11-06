import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cookieProblems, dubaiSearchBody, leakedPatterns, normaliseTarget, runSmoke } from './hosted-agent-smoke.mjs'

test('the target must be an https bare origin (http only for localhost when allowed)', () => {
  assert.equal(normaliseTarget('https://agent.example.com'), 'https://agent.example.com')
  for (const bad of ['http://agent.example.com', 'https://u:p@agent.example.com', 'https://agent.example.com/login', 'https://agent.example.com/?x=1', 'agent.example.com', '']) assert.throws(() => normaliseTarget(bad), /HOSTED_AGENT_URL/)
  assert.throws(() => normaliseTarget('http://localhost:3003'), /https/)
  assert.equal(normaliseTarget('http://localhost:3003', { allowLocalHttp: true }), 'http://localhost:3003')
  assert.throws(() => normaliseTarget('http://agent.example.com', { allowLocalHttp: true }), /https/)
})

test('session cookie problems are named', () => {
  assert.deepEqual(cookieProblems('fbeds_session=x; Path=/; HttpOnly; Secure; SameSite=Lax'), [])
  assert.deepEqual(cookieProblems('fbeds_session=x; Path=/; HttpOnly; SameSite=Lax', { hosted: false }), [])
  const bad = cookieProblems('s=x; Domain=.example.com; SameSite=None')
  assert.ok(bad.some((p) => /HttpOnly/.test(p)) && bad.some((p) => /Secure/.test(p)) && bad.some((p) => /Domain/.test(p)) && bad.some((p) => /None/.test(p)))
  assert.deepEqual(cookieProblems(null), ['no session cookie was set'])
})

test('server-only names and connection strings are detected without echoing a value', () => {
  assert.deepEqual(leakedPatterns('plain marketing text'), [])
  assert.ok(leakedPatterns('x postgresql://user:pw@h/db y').length === 1)
  assert.ok(leakedPatterns('API_INTERNAL_URL=https://x').length === 1)
})

test('the search body is the canonical Dubai one-room two-adult AED request', () => {
  const b = dubaiSearchBody('2030-01-01', '2030-01-03')
  assert.deepEqual([b.destinationRef.id, b.rooms, b.adults, b.currency], ['city:AE:dubai', 1, 2, 'AED'])
})

test('the smoke fails closed against an API that serves nothing useful, and never prints credentials', async () => {
  const logs = []
  const fetchImpl = async () => new Response('nope', { status: 500 })
  const out = await runSmoke({ origin: 'https://agent.example.com', email: 'a@b.c', password: 'super-secret-pw', fetchImpl, log: (l) => logs.push(l) })
  assert.equal(out.ok, false)
  assert.ok(!logs.join('\n').includes('super-secret-pw'))
  assert.ok(out.results.some((r) => r.name.startsWith('H1') && !r.ok))
})

function closedApi({ bookingEnabled = false, bookingStatus = 503 } = {}) {
  const seen = []
  let signedIn = false
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    const method = init.method ?? 'GET'
    seen.push(`${method} ${url.pathname}`)
    const json = (status, data, extra = {}) => new Response(JSON.stringify({ data }), { status, headers: extra })
    if (url.pathname === '/login') return new Response('<html><body>Sign in</body></html>', { status: 200 })
    if (url.pathname === '/api/v1/health') return json(200, { status: 'ok' })
    if (url.pathname === '/api/v1/auth/login') {
      signedIn = true
      return json(200, { ok: true }, { 'set-cookie': 'fbeds_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax' })
    }
    if (url.pathname === '/api/v1/auth/logout') { signedIn = false; return json(200, { ok: true }) }
    if (url.pathname === '/api/v1/agent/context') return signedIn ? json(200, { memberships: [{ tenantId: 'ten-1' }], bookingEnabled }) : json(401, null)
    if (url.pathname === '/api/v1/agent/destinations') return json(200, { results: [{ id: 'city:AE:dubai' }] })
    if (url.pathname === '/api/v1/agent/search') return json(201, { searchId: 'search-1', pagination: { total: 1 }, hotels: [{ rooms: [{ rates: [{ availability: 'available', offerId: 'offer-1', total: { currency: 'AED' }, sellAmountMinor: 10000 }] }] }] })
    if (url.pathname === '/api/v1/agent/rates/recheck') return json(200, { status: 'rechecked' })
    if (url.pathname === '/api/v1/agent/bookings' || url.pathname === '/api/v1/agent/prebook' || url.pathname === '/api/v1/agent/offers/offer-1/hold') {
      return json(bookingStatus, { status: bookingStatus === 503 ? 'booking_unavailable' : 'created' })
    }
    return json(404, null)
  }
  return { fetchImpl, seen }
}

test('hosted booking is certified closed only on the real hold, prebook and create routes', async () => {
  const logs = []
  const api = closedApi()
  const out = await runSmoke({ origin: 'https://agent.example.com', email: 'agent@example.com', password: 'super-secret-pw', fetchImpl: api.fetchImpl, log: (line) => logs.push(line) })
  assert.equal(out.ok, true, JSON.stringify(out.results.filter((result) => !result.ok)))
  assert.equal(out.results.length, 13)
  assert.ok(api.seen.includes('POST /api/v1/agent/bookings'))
  assert.ok(api.seen.includes('POST /api/v1/agent/prebook'))
  assert.ok(api.seen.includes('POST /api/v1/agent/offers/offer-1/hold'))
  assert.ok(!api.seen.some((line) => line.includes('/holds')))
  assert.ok(!logs.join('\n').includes('super-secret-pw'))
  assert.ok(!logs.join('\n').includes('Test'))
})

test('a 2xx booking response or an open booking flag fails the hosted gate', async () => {
  const open = await runSmoke({ origin: 'https://agent.example.com', email: 'a@b.c', password: 'pw', fetchImpl: closedApi({ bookingStatus: 201 }).fetchImpl, log: () => {} })
  assert.equal(open.ok, false)
  assert.ok(open.results.some((result) => result.name.startsWith('H12') && !result.ok))
  const flagged = await runSmoke({ origin: 'https://agent.example.com', email: 'a@b.c', password: 'pw', fetchImpl: closedApi({ bookingEnabled: true }).fetchImpl, log: () => {} })
  assert.equal(flagged.ok, false)
  assert.ok(flagged.results.some((result) => result.name.startsWith('H7') && !result.ok))
})
