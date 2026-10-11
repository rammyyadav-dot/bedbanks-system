// Agent search must offer only ACTIVE rate plans (ADR 0041). Run after seed-agent-mvp.ts against the strict-role API (:3002).
// Suspends and drafts one hotel's plans through the owner connection (the lifecycle routes are covered by the e2e suites), searches
// as an Agent over HTTP, checks the hotel disappears and the others stay, then restores. Disposable database only.
const path = require('path')
const { execFileSync } = require('child_process')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-agent-mvp.json'))
const API = process.env.API_URL ?? 'http://127.0.0.1:3002/api/v1'
const OWNER = process.env.OWNER_DATABASE_URL
if (!OWNER || !/@(localhost|127\.0\.0\.1):\d+\/(fbeds_ci|p0\d_[a-z0-9_]+)/.test(OWNER)) throw new Error('OWNER_DATABASE_URL must be a disposable local database')
const sql = (q) => execFileSync('psql', [OWNER, '-Atc', q], { encoding: 'utf8' }).trim()
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }
;(async () => {
  const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3003' }, body: JSON.stringify({ email: seed.agentEmail, password: seed.password }) })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const search = async () => {
    const r = await fetch(`${API}/agent/search`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3003', cookie, 'x-fbeds-tenant-id': seed.tenantA }, body: JSON.stringify({ destination: 'Dubai', checkIn: day(10), checkOut: day(12), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'GB', currency: 'AED', limit: 100 }) })
    const body = await r.json(); return { status: r.status, hotels: (body.data?.hotels ?? []).map((h) => h.hotelId), total: body.data?.total ?? body.data?.pagination?.total }
  }
  const target = seed.hotels.f1, other = seed.hotels.f2, ids = seed.plans.f1.map((id) => `'${id}'`).join(',')
  const base = await search()
  check('baseline: search succeeds and offers the target and another hotel', [200, 201].includes(base.status) && base.hotels.includes(target) && base.hotels.includes(other), `status ${base.status}, ${base.hotels.length} hotels`)
  try {
    sql(`update "RatePlan" set status='SUSPENDED' where id in (${ids})`)
    const suspended = await search()
    check('a SUSPENDED plan is not offered; its hotel disappears (no fallback to another plan)', [200, 201].includes(suspended.status) && !suspended.hotels.includes(target) && suspended.hotels.includes(other), `${suspended.hotels.length} hotels`)
    sql(`update "RatePlan" set status='DRAFT' where id in (${ids})`)
    check('a DRAFT plan is not offered', !(await search()).hotels.includes(target))
    sql(`update "RatePlan" set status='EXPIRED' where id in (${ids})`)
    check('an EXPIRED plan is not offered', !(await search()).hotels.includes(target))
  } finally { sql(`update "RatePlan" set status='ACTIVE' where id in (${ids})`) }
  const restored = await search()
  check('after restoring ACTIVE the hotel is offered again, with the same count as baseline', restored.hotels.includes(target) && restored.hotels.length === base.hotels.length, `${restored.hotels.length} vs ${base.hotels.length}`)
  check('searching created no hold, booking or ledger row', sql(`select (select count(*) from "InventoryHold")||'/'||(select count(*) from "Booking")||'/'||(select count(*) from "LedgerEntry")`) === '0/0/0')
  const failed = results.filter((x) => !x).length; console.log(`\n${results.length - failed}/${results.length} checks passed`); process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
