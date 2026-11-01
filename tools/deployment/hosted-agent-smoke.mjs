#!/usr/bin/env node
/**
 * Hosted Agent acceptance smoke (docs/runbooks/hosted-agent-acceptance.md). Run by the owner against a deployed (preview or production) Agent URL:
 *
 *   HOSTED_AGENT_URL=https://<agent host> HOSTED_AGENT_EMAIL=<test agent> HOSTED_AGENT_PASSWORD=<secret> node tools/deployment/hosted-agent-smoke.mjs
 *
 * What it does, over the public same-origin paths only: checks the proxy reaches the API, signs in with an AUTHORIZED TEST ACCOUNT (this creates one
 * session and nothing else), runs one Dubai search (one room, two adults), rechecks the first offer, proves the booking endpoints are closed, signs
 * out, and scans the served HTML and scripts for server-only values. It never creates a hold, booking, payment or any inventory change, never prints
 * the credentials, the cookie or a guest value, and exits non-zero on any failed check. Use only an isolated API and a test account.
 */

const SECRET_PATTERNS = [/API_INTERNAL_URL/, /postgres(ql)?:\/\//i, /DATABASE_URL/, /fbeds_api_login/, /SUPPLIER_API_KEY|CONNECTOR_SECRET/i]

/** The target must be an https origin (http only for localhost tests), without credentials, path, query or fragment. */
export function normaliseTarget(raw, { allowLocalHttp = false } = {}) {
  let url
  try { url = new URL(raw) } catch { throw new Error('HOSTED_AGENT_URL must be an absolute URL') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(allowLocalHttp && local && url.protocol === 'http:')) throw new Error('HOSTED_AGENT_URL must use https (http is accepted only for localhost with --allow-local-http)')
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('HOSTED_AGENT_URL must be a bare origin without credentials, path, query or fragment')
  return url.origin
}

/** Problems with a session Set-Cookie header: it must be host-only, HttpOnly, Secure (hosted) and never SameSite=None. */
export function cookieProblems(setCookie, { hosted = true } = {}) {
  const problems = []
  if (!setCookie) return ['no session cookie was set']
  const attrs = setCookie.split(';').map((p) => p.trim().toLowerCase())
  if (!attrs.includes('httponly')) problems.push('session cookie is not HttpOnly')
  if (hosted && !attrs.includes('secure')) problems.push('session cookie is not Secure')
  if (attrs.some((a) => a.startsWith('domain='))) problems.push('session cookie has a Domain attribute (it must be host-only)')
  if (attrs.includes('samesite=none')) problems.push('session cookie is SameSite=None')
  return problems
}

/** Names of the server-only patterns present in served text. Values are never returned. */
export function leakedPatterns(text) { return SECRET_PATTERNS.filter((p) => p.test(text)).map((p) => String(p)) }

export const dubaiSearchBody = (checkIn, checkOut) => ({
  destination: 'Dubai', destinationRef: { type: 'city', id: 'city:AE:dubai', countryCode: 'AE' }, checkIn, checkOut,
  rooms: 1, adults: 2, children: 0, childAges: [], roomStays: [{ adults: 2, children: [] }], nationality: 'IN', currency: 'AED', limit: 25,
})

const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

export async function runSmoke({ origin, email, password, fetchImpl = fetch, log = () => {}, hosted = true }) {
  const results = []
  const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 200) }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 200) : ''}`) }
  const call = (path, init = {}, cookie) => fetchImpl(`${origin}${path}`, { redirect: 'manual', ...init, headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } })
  const json = async (r) => { try { return await r.json() } catch { return null } }

  // 1. the Agent serves, and serves nothing server-only
  const login = await call('/login', { headers: { accept: 'text/html' } })
  const html = await login.text()
  check('H1 the Agent serves its sign-in page', login.status === 200 && /<html/i.test(html), `status ${login.status}`)
  const scripts = [...new Set([...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]))].slice(0, 25)
  let served = html
  for (const s of scripts) { try { served += await (await call(s)).text() } catch { /* a missing chunk is reported by H1/H2 */ } }
  const leaks = leakedPatterns(served)
  check('H2 the served HTML and scripts contain no server-only value names or connection strings', leaks.length === 0, leaks.join(', ') || `${scripts.length} scripts scanned`)

  // 2. the same-origin proxy reaches the API
  const health = await call('/api/v1/health')
  check('H3 the same-origin /api/v1 proxy reaches the API (health 200)', health.status === 200, `status ${health.status}`)
  const anon = await call('/api/v1/agent/context')
  check('H4 an unauthenticated request is refused (401), not served', anon.status === 401, `status ${anon.status}`)

  // 3. sign in
  const signIn = await call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  const setCookies = signIn.headers.getSetCookie?.() ?? [signIn.headers.get('set-cookie')].filter(Boolean)
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
  check('H5 sign-in with the test account succeeds', signIn.status === 200 && cookie.length > 0, `status ${signIn.status}`)
  if (!cookie) return finish(results)
  const problems = setCookies.flatMap((c) => cookieProblems(c, { hosted }))
  check('H6 the session cookie is host-only, HttpOnly and Secure', problems.length === 0, problems.join('; '))
  const ctx = await json(await call('/api/v1/agent/context', {}, cookie))
  const tenantId = ctx?.data?.memberships?.[0]?.tenantId
  check('H7 the authenticated context names the workspace from the server and reports booking state', typeof tenantId === 'string' && typeof ctx?.data?.bookingEnabled === 'boolean', `bookingEnabled=${ctx?.data?.bookingEnabled}`)
  if (!tenantId) return finish(results)
  const tenant = { 'x-fbeds-tenant-id': tenantId }

  // 4. Dubai search and authoritative recheck (read-only)
  const dest = await json(await call('/api/v1/agent/destinations?q=Dubai', { headers: tenant }, cookie))
  check('H8 Dubai resolves from the canonical destination catalogue', Array.isArray(dest?.data?.results) && dest.data.results.some((d) => d.id === 'city:AE:dubai'), `${dest?.data?.results?.length ?? 0} results`)
  const searchRes = await call('/api/v1/agent/search', { method: 'POST', headers: tenant, body: JSON.stringify(dubaiSearchBody(day(14), day(16))) }, cookie)
  const search = await json(searchRes)
  const hotels = search?.data?.hotels ?? []
  check('H9 a Dubai search (one room, two adults, AED) returns hotels with server pagination', [200, 201].includes(searchRes.status) && hotels.length > 0 && Boolean(search.data.pagination), `status ${searchRes.status}, ${hotels.length} hotels, total ${search?.data?.pagination?.total}`)
  const rate = hotels.flatMap((h) => h.rooms.flatMap((r) => r.rates)).find((r) => r.availability === 'available')
  check('H10 the offers carry canonical offer ids and AED totals', Boolean(rate) && /^[\w-]+$/.test(rate.offerId) && rate.total.currency === 'AED' && Number.isSafeInteger(rate.sellAmountMinor), rate ? `${rate.total.currency} minor ${rate.sellAmountMinor}` : 'no available offer in the first page')
  if (rate) {
    const rc = await json(await call('/api/v1/agent/rates/recheck', { method: 'POST', headers: tenant, body: JSON.stringify({ offerId: rate.offerId, searchId: search.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: rate.sellAmountMinor }) }, cookie))
    check('H11 the authoritative recheck answers with a defined outcome', ['rechecked', 'price_changed', 'unavailable', 'offer_expired'].includes(rc?.data?.status), `status=${rc?.data?.status}`)
  }

  // 5. booking stays closed
  const bk = await call('/api/v1/agent/bookings', { method: 'POST', headers: tenant, body: '{}' }, cookie)
  const hold = await call('/api/v1/agent/holds', { method: 'POST', headers: tenant, body: '{}' }, cookie)
  check('H12 booking and hold endpoints are closed (no 2xx)', bk.status >= 400 && hold.status >= 400, `${bk.status}/${hold.status}`)

  // 6. sign out
  await call('/api/v1/auth/logout', { method: 'POST', body: '{}' }, cookie)
  const after = await call('/api/v1/agent/context', {}, cookie)
  check('H13 sign-out ends the session (the old cookie is refused)', after.status === 401, `status ${after.status}`)
  return finish(results)
}

function finish(results) { return { ok: results.every((r) => r.ok), results } }

async function main() {
  const args = process.argv.slice(2)
  const origin = normaliseTarget(process.env.HOSTED_AGENT_URL ?? '', { allowLocalHttp: args.includes('--allow-local-http') })
  const email = process.env.HOSTED_AGENT_EMAIL; const password = process.env.HOSTED_AGENT_PASSWORD
  if (!email || !password) throw new Error('HOSTED_AGENT_EMAIL and HOSTED_AGENT_PASSWORD (an authorized test account) are required')
  console.log(`Target: ${origin}`)
  const out = await runSmoke({ origin, email, password, log: console.log, hosted: origin.startsWith('https:') })
  console.log(`\nResult: ${out.ok ? 'PASS' : 'FAIL'} (${out.results.filter((r) => r.ok).length}/${out.results.length})`)
  process.exitCode = out.ok ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e instanceof Error ? e.message : 'Smoke failed'); process.exit(1) })
