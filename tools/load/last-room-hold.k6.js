/**
 * k6 contention test: many agents try to hold the SAME last unit at once (booking concurrency, ADR 0005 / docs/booking-concurrency-foundation.md).
 *
 *   k6 run -e BASE_URL=https://staging.example/api/v1 -e OFFER_ID=<offer> -e SEARCH_ID=<search> \
 *          -e SELL_MINOR=100000 -e CURRENCY=AED -e UNITS_AVAILABLE=1 -e HEADERS_JSON='{"Cookie":"<session>"}' \
 *          tools/load/last-room-hold.k6.js
 *
 * Run it ONLY against a disposable or staging tenant whose inventory for OFFER_ID you have set to exactly UNITS_AVAILABLE rooms and BOOKING_ENABLED=true.
 * It creates real holds (they expire on their own; release them with DELETE /agent/holds/:id or let the sweeper do it).
 *
 * What it proves from the client side: at most UNITS_AVAILABLE requests get 201 `held`, every other request gets a clean 409 `unavailable` (never 5xx), and a request
 * is never answered twice for one idempotency key. What it cannot prove: that the database counters are right. Run the SQL in
 * docs/booking-operations-completion-gap-analysis.md afterwards (held must equal UNITS_AVAILABLE, never exceed allotment).
 *
 * Session auth is passed in HEADERS_JSON on purpose: this script never logs it, and tenant identity stays whatever the server derives from that session (invariant 1).
 */
import http from 'k6/http'
import { check } from 'k6'
import { Counter } from 'k6/metrics'

const required = (name) => { const v = __ENV[name]; if (!v) throw new Error(`${name} is required`); return v }
const BASE_URL = required('BASE_URL')
const OFFER_ID = required('OFFER_ID')
const SEARCH_ID = required('SEARCH_ID')
const SELL_MINOR = Number(required('SELL_MINOR'))
const CURRENCY = required('CURRENCY')
const UNITS = Number(__ENV.UNITS_AVAILABLE || 1)
const HEADERS = JSON.parse(required('HEADERS_JSON'))
const VUS = Number(__ENV.VUS || 50)
const RUN_ID = __ENV.RUN_ID || `${Date.now()}`

const held = new Counter('holds_created')
const refused = new Counter('holds_refused_unavailable')
const unexpected = new Counter('holds_unexpected_response')

export const options = {
  scenarios: {
    // Every virtual user fires once, at the same instant: the worst case for a last-unit race.
    stampede: { executor: 'per-vu-iterations', vus: VUS, iterations: 1, maxDuration: '2m' },
  },
  thresholds: {
    holds_created: [`count<=${UNITS}`], // oversell: more winners than rooms fails the run
    holds_unexpected_response: ['count==0'], // any 5xx, 429, malformed or unknown status fails the run
    http_req_failed: [{ threshold: 'rate<=1', abortOnFail: false }], // 409s are expected; failure is judged by the counters above
  },
}

export default function () {
  // A distinct key per virtual user: the contention must be settled by inventory, not collapsed by idempotency.
  const idempotencyKey = `k6-${RUN_ID}-vu${__VU}`
  const res = http.post(
    `${BASE_URL}/agent/offers/${encodeURIComponent(OFFER_ID)}/hold`,
    JSON.stringify({ searchId: SEARCH_ID, expectedCurrency: CURRENCY, expectedSellAmountMinor: SELL_MINOR, idempotencyKey }),
    { headers: { 'Content-Type': 'application/json', ...HEADERS }, tags: { name: 'hold_last_unit' } },
  )
  const status = res.status
  let body = null
  try { body = res.json() } catch (e) { body = null }
  if (status === 201 && body && body.status === 'held') held.add(1)
  else if (status === 409 && body && body.status === 'unavailable') refused.add(1)
  else unexpected.add(1)
  check(res, { 'never a server error': (r) => r.status < 500 })
}
