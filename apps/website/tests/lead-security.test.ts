import assert from 'node:assert/strict'
import test from 'node:test'
import { submitLead } from '../lib/leads/lead-adapter'
import { processLeadSubmission } from '../lib/leads/process'
import { createRateLimiter } from '../lib/leads/rate-limit'
import { MemoryNonceStore, signLeadRequest, verifyLeadRequest } from '../lib/leads/signing'
import type { LeadInput } from '../lib/leads/validation'

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef'
const ENDPOINT = 'https://leads.example.test'
const lead: Omit<LeadInput, 'website'> = { fullName: 'Asha Patel', businessEmail: 'asha@example.com', company: 'Example Travel', market: 'United Kingdom', businessType: 'Travel agency', monthlyVolume: '100–999', interestArea: 'B2B distribution', message: 'We need to review a distribution model for several markets.', consent: true }

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries({ ...lead, consent: 'on', website: '', ...overrides })) data.set(key, String(value))
  return data
}
const limiter = () => createRateLimiter({ limit: 5, windowMs: 600_000 })
const okFetcher = (calls: unknown[] = []) => (async (...args: unknown[]) => { calls.push(args); return Response.json({ accepted: true, reference: 'lead-1' }) }) as unknown as typeof fetch
function withEnv(nodeEnv: string, work: () => Promise<void>): Promise<void> {
  const env = process.env as Record<string, string | undefined>; const saved = env.NODE_ENV; env.NODE_ENV = nodeEnv
  return work().finally(() => { env.NODE_ENV = saved })
}

// --- signing ---
const now = 1_800_000_000
const body = JSON.stringify(lead)
const headersFor = (nowSeconds = now, nonce?: string) => signLeadRequest(SECRET, body, { nowSeconds, nonce })

test('a correctly signed request verifies', async () => assert.deepEqual(await verifyLeadRequest({ secret: SECRET, rawBody: body, headers: headersFor(), nonceStore: new MemoryNonceStore(), nowSeconds: now }), { ok: true }))
test('a tampered body, wrong secret or altered signature is rejected', async () => {
  const headers = headersFor()
  for (const input of [{ secret: SECRET, rawBody: body + ' ', headers }, { secret: 'x'.repeat(40), rawBody: body, headers }, { secret: SECRET, rawBody: body, headers: { ...headers, 'x-fbeds-signature': 'v1=' + '0'.repeat(64) } }]) {
    assert.deepEqual(await verifyLeadRequest({ ...input, nonceStore: new MemoryNonceStore(), nowSeconds: now }), { ok: false, reason: 'signature' })
  }
})
test('expired and far-future timestamps are rejected', async () => {
  for (const issued of [now - 301, now + 301]) assert.deepEqual(await verifyLeadRequest({ secret: SECRET, rawBody: body, headers: headersFor(issued), nonceStore: new MemoryNonceStore(), nowSeconds: now }), { ok: false, reason: 'expired' })
})
test('a replayed nonce is rejected after the first accepted request', async () => {
  const store = new MemoryNonceStore(); const headers = headersFor()
  assert.deepEqual(await verifyLeadRequest({ secret: SECRET, rawBody: body, headers, nonceStore: store, nowSeconds: now }), { ok: true })
  assert.deepEqual(await verifyLeadRequest({ secret: SECRET, rawBody: body, headers, nonceStore: store, nowSeconds: now + 5 }), { ok: false, reason: 'replay' })
})
test('an invalid signature does not consume the nonce', async () => {
  const store = new MemoryNonceStore(); const headers = headersFor()
  await verifyLeadRequest({ secret: 'x'.repeat(40), rawBody: body, headers, nonceStore: store, nowSeconds: now })
  assert.deepEqual(await verifyLeadRequest({ secret: SECRET, rawBody: body, headers, nonceStore: store, nowSeconds: now }), { ok: true })
})
test('missing and malformed headers are rejected', async () => {
  const store = new MemoryNonceStore()
  assert.deepEqual(await verifyLeadRequest({ secret: SECRET, rawBody: body, headers: {}, nonceStore: store, nowSeconds: now }), { ok: false, reason: 'missing' })
  assert.deepEqual(await verifyLeadRequest({ secret: SECRET, rawBody: body, headers: { ...headersFor(), 'x-fbeds-nonce': 'short' }, nonceStore: store, nowSeconds: now }), { ok: false, reason: 'malformed' })
})

// --- downstream request (adapter) ---
test('the downstream request is signed, never follows redirects, and the signature verifies', async () => {
  const calls: unknown[][] = []
  const result = await submitLead(lead, { endpoint: ENDPOINT, signingSecret: SECRET, fetcher: okFetcher(calls), log: () => undefined })
  assert.equal(result.status, 'success')
  const [, init] = calls[0] as [URL, RequestInit]
  assert.equal(init.redirect, 'error')
  const headers = init.headers as Record<string, string>
  assert.deepEqual(await verifyLeadRequest({ secret: SECRET, rawBody: init.body as string, headers: headers as never, nonceStore: new MemoryNonceStore() }), { ok: true })
})
test('an unsigned request is never sent: missing or short secret fails closed', async () => {
  const calls: unknown[] = []
  for (const signingSecret of [undefined, 'short']) {
    const result = await submitLead(lead, { endpoint: ENDPOINT, signingSecret, fetcher: okFetcher(calls), log: () => undefined })
    assert.deepEqual(result, { status: 'failed', message: 'The lead service is not configured correctly.' })
  }
  assert.equal(calls.length, 0)
})
test('production rejects http, private hosts and credentialed endpoints', async () => withEnv('production', async () => {
  for (const endpoint of ['http://leads.example.test', 'https://localhost/leads', 'https://10.0.0.5/leads', 'https://169.254.169.254/latest', 'https://user:pass@leads.example.test']) {
    const calls: unknown[] = []
    const result = await submitLead(lead, { endpoint, signingSecret: SECRET, fetcher: okFetcher(calls), log: () => undefined })
    assert.equal(result.status, 'failed', endpoint); assert.equal(calls.length, 0, endpoint)
  }
}))
test('an unauthorized receiver response and a server error give sanitized failures', async () => {
  for (const status of [401, 403, 500]) {
    const events: string[] = []
    const result = await submitLead(lead, { endpoint: ENDPOINT, signingSecret: SECRET, fetcher: (async () => new Response('internal detail asha@example.com', { status })) as unknown as typeof fetch, log: (event) => events.push(event) })
    assert.deepEqual(result, { status: 'failed', message: 'The enquiry service did not accept the request.' })
    assert.deepEqual(events, [`receiver_status_${status}`])
  }
})
test('timeouts and network failures are sanitized and logs never contain personal data', async () => {
  const events: string[] = []
  const result = await submitLead(lead, { endpoint: ENDPOINT, signingSecret: SECRET, timeoutMs: 10, fetcher: ((_url: unknown, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('asha@example.com ' + SECRET))))) as unknown as typeof fetch, log: (event) => events.push(event) })
  assert.deepEqual(result, { status: 'failed', message: 'The enquiry service is temporarily unavailable.' })
  const logged = events.join(' ')
  for (const secretValue of [lead.businessEmail, lead.fullName, SECRET, ENDPOINT]) assert.ok(!logged.includes(secretValue))
})

// --- submission pipeline ---
test('an accepted lead and a honeypot hit return the same generic success, but only the lead is sent', async () => {
  const sent: unknown[] = []; const submit = async (input: unknown) => { sent.push(input); return { status: 'success' as const, reference: 'lead-1' } }
  const accepted = await processLeadSubmission(form(), { limiter: limiter(), clientId: 'a', submit })
  const paused: number[] = []
  const trapped = await processLeadSubmission(form({ website: 'https://spam.example' }), { limiter: limiter(), clientId: 'b', submit, pause: async (ms) => { paused.push(ms) }, random: () => 0.5 })
  assert.deepEqual(trapped, accepted)
  assert.equal(accepted.message, undefined)
  assert.equal(sent.length, 1)
  assert.deepEqual(paused, [550])
})
test('a honeypot hit creates no lead even when the lead service is configured', async () => {
  const calls: unknown[] = []
  const result = await processLeadSubmission(form({ website: 'x' }), { limiter: limiter(), clientId: 'c', adapterOptions: { endpoint: ENDPOINT, signingSecret: SECRET, fetcher: okFetcher(calls) }, pause: async () => undefined })
  assert.equal(result.status, 'success'); assert.equal(calls.length, 0)
})
test('invalid and oversized input is rejected on the server without a downstream call', async () => {
  const calls: unknown[] = []; const submit = async (input: unknown) => { calls.push(input); return { status: 'success' as const } }
  const cases: Record<string, string>[] = [{ businessEmail: 'nope' }, { consent: '' }, { message: 'short' }, { message: 'x'.repeat(2001) }, { fullName: 'x'.repeat(121) }, { company: 'x'.repeat(161) }, { businessEmail: 'a'.repeat(250) + '@example.com' }, { businessType: 'Spaceship' }]
  for (const overrides of cases) {
    const data = form(overrides); if (overrides.consent === '') data.delete('consent')
    assert.equal((await processLeadSubmission(data, { limiter: limiter(), clientId: 'd', submit })).status, 'invalid', JSON.stringify(overrides).slice(0, 40))
  }
  assert.equal(calls.length, 0)
})
test('the sixth request from one client in the window is rate limited and others are unaffected', async () => {
  let clock = 0; const shared = createRateLimiter({ limit: 5, windowMs: 600_000, now: () => clock })
  const submit = async () => ({ status: 'success' as const })
  for (let i = 0; i < 5; i += 1) assert.equal((await processLeadSubmission(form(), { limiter: shared, clientId: 'same', submit })).status, 'success')
  const blocked = await processLeadSubmission(form(), { limiter: shared, clientId: 'same', submit })
  assert.equal(blocked.status, 'failed'); assert.match(blocked.message ?? '', /Too many requests/)
  assert.equal((await processLeadSubmission(form(), { limiter: shared, clientId: 'other', submit })).status, 'success')
  clock = 600_001
  assert.equal((await processLeadSubmission(form(), { limiter: shared, clientId: 'same', submit })).status, 'success')
})
test('honeypot hits also consume rate limit budget', async () => {
  const shared = limiter()
  for (let i = 0; i < 5; i += 1) await processLeadSubmission(form({ website: 'x' }), { limiter: shared, clientId: 'bot', pause: async () => undefined })
  assert.equal((await processLeadSubmission(form({ website: 'x' }), { limiter: shared, clientId: 'bot', pause: async () => undefined })).status, 'failed')
})
test('an unconfigured lead service and receiver failures are reported honestly, never as success', async () => {
  assert.equal((await processLeadSubmission(form(), { limiter: limiter(), clientId: 'e', adapterOptions: { endpoint: '' } })).status, 'not_configured')
  const failed = await processLeadSubmission(form(), { limiter: limiter(), clientId: 'f', adapterOptions: { endpoint: ENDPOINT, signingSecret: SECRET, fetcher: (async () => new Response('x', { status: 500 })) as unknown as typeof fetch, log: () => undefined } })
  assert.equal(failed.status, 'failed')
  assert.ok(!JSON.stringify(failed).includes('asha@example.com'))
})
test('the rate limiter bounds its memory', () => {
  const small = createRateLimiter({ limit: 1, windowMs: 600_000, maxKeys: 3 })
  for (let i = 0; i < 50; i += 1) small.check(`k${i}`)
  assert.equal(small.check('k49').allowed, false)
  assert.equal(small.check('k0').allowed, true)
})
