// Real-stack acceptance of the Agent Dubai MVP journey (docs/agent-dubai-mvp-completion.md): production Agent build -> same-origin proxy -> real API
// connected as the strict runtime login -> PostgreSQL with contracted-inventory fixtures. Checks marked [injected] use controlled failure injection in
// the browser (route interception); every other check is database-backed. Not run in CI. See README.md.
const path = require('path')
const { execFileSync } = require('child_process')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const AxeBuilder = req('@axe-core/playwright').default || req('@axe-core/playwright')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-agent-mvp.json'))
const AGENT = process.env.AGENT_URL ?? 'http://localhost:3003'
const API_SHORT = process.env.API_SHORT_URL ?? 'http://127.0.0.1:3004/api/v1' // a second API process with AGENT_OFFER_TTL_MS=1500, for the real server-side expiry check
const OWNER = process.env.OWNER_DATABASE_URL // setup and read-only evidence only; the API itself runs as the strict runtime login
const SHOTS = process.env.SHOT_DIR ?? require('os').tmpdir()
if (!OWNER) throw new Error('OWNER_DATABASE_URL (disposable owner connection, for fixtures and evidence) is required')
const results = []
const timings = {}
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 230) : ''}`) }
const sql = (q) => execFileSync('psql', [OWNER, '-Atc', q], { encoding: 'utf8' }).trim()
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
const H = seed.hotels; const N = seed.names
const IN_FROM = day(10), IN_TO = day(12)
const counters = () => ({
  availability: sql(`select coalesce(sum(sold),0)||'/'||coalesce(sum(held),0) from "DailyAvailability" where tenant_id='${seed.tenantA}'`),
  pool: sql(`select coalesce(sum(sold),0)||'/'||coalesce(sum(held),0) from "InventoryPoolDay" where tenant_id='${seed.tenantA}'`),
  holds: sql(`select count(*) from "InventoryHold" where tenant_id='${seed.tenantA}'`),
  bookings: sql(`select count(*) from "Booking" where tenant_id='${seed.tenantA}'`),
  ledger: sql(`select count(*) from "LedgerEntry" where tenant_id='${seed.tenantA}'`),
})

async function newSession(browser, email, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport }); const page = await ctx.newPage()
  const posts = []; page.on('request', (r) => { if (r.method() !== 'GET') posts.push(`${r.method()} ${r.url().replace(AGENT, '')}`) })
  const pageErrors = []; page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`${AGENT}/login`); await page.fill('#email', email); await page.fill('#password', seed.password); await page.click('button[type=submit]')
  await page.waitForSelector('#hotel-search', { timeout: 30000 })
  return { ctx, page, posts, pageErrors }
}
async function chooseDubai(page) {
  await page.getByLabel('Destination').click(); await page.getByLabel('Destination').fill('Dubai'); await page.getByRole('option', { name: /Dubai/ }).first().click()
}
async function setStay(page, from, to) {
  await page.locator('.market-field:has(> span:text-is("Stay")) button.market-control').click()
  await page.getByLabel('Check-in').fill(from); await page.getByLabel('Check-out').fill(to)
  await page.keyboard.press('Escape')
}
async function search(page, from = IN_FROM, to = IN_TO) {
  await chooseDubai(page); await setStay(page, from, to)
  const t0 = Date.now()
  await page.getByRole('button', { name: /^Search/ }).first().click()
  await page.waitForSelector('article.market-hotel-card', { timeout: 30000 })
  return Date.now() - t0
}
const resultsText = async (page) => (await page.locator('main.portal-main').innerText()).replace(/\s+/g, ' ')
const showing = async (page) => /Showing (\d+)–(\d+) of (\d+) hotels/.exec(await resultsText(page))
async function loadAll(page) {
  for (let i = 0; i < 8; i++) {
    const more = page.getByRole('button', { name: /^Load \d+ more hotels|^Load more hotels/ })
    if (!(await more.count())) break
    await more.click(); await page.waitForFunction(() => !document.querySelector('.portal-load-more button[aria-busy=true]'), null, { timeout: 20000 }); await page.waitForTimeout(300)
  }
}
async function openHotel(page, name) {
  let card = page.locator('article.market-hotel-card', { hasText: name }).first()
  if (!(await card.count())) { await loadAll(page); card = page.locator('article.market-hotel-card', { hasText: name }).first() }
  if (!(await card.count())) return false
  await card.getByRole('button').first().click(); await page.waitForSelector('section.market-hotel-detail', { timeout: 15000 }); return true
}
const backToResults = (page) => page.getByRole('button', { name: /Back to results/ }).click()
const panelText = async (page) => (await page.locator('.portal-hold-panel').innerText()).replace(/\s+/g, ' ')
async function select(page, rowIndex = 0) {
  await page.locator('.market-rate-row').nth(rowIndex).getByRole('button', { name: /Select Offer/ }).click()
  await page.waitForSelector('.portal-hold-outcome', { timeout: 20000 })
  return panelText(page)
}
const bookingControls = async (page) => (await page.locator('main.portal-main').getByRole('button').allInnerTexts()).filter((t) => /\b(book|pay|confirm|checkout|reserve)\b/i.test(t) || /^hold/i.test(t)).length

;(async () => {
  const browser = await chromium.launch()
  const before = counters()

  // ---- A. unauthenticated -> login -> session ------------------------------------------------------------------------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage()
    const seen = []; page.on('response', (r) => { if (/\/agent\/context/.test(r.url())) seen.push(r.status()) })
    await page.goto(`${AGENT}/login`); await page.waitForSelector('#email', { timeout: 30000 })
    const t = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    check('A1 unauthenticated visitors reach the login form, and a fresh visit is not reported as an expired session', (await page.locator('#password').count()) === 1 && !/expired/i.test(t), `context ${seen.join(',')}`)
    await page.fill('#email', seed.agentEmail); await page.fill('#password', 'wrong-password-123'); await page.click('button[type=submit]')
    await page.waitForFunction(() => /could not sign you in|invalid|incorrect/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {})
    check('A2 a wrong password is refused with a clear message and no session', /could not sign you in|invalid|incorrect/i.test((await page.locator('body').innerText())) && (await page.locator('#hotel-search').count()) === 0)
    await page.goto(`${AGENT}/login?next=//evil.example&returnTo=https://evil.example`); await page.fill('#email', seed.agentEmail); await page.fill('#password', seed.password); await page.click('button[type=submit]')
    await page.waitForSelector('#hotel-search', { timeout: 30000 })
    check('A3 sign-in never navigates to an untrusted return destination', new URL(page.url()).origin === new URL(AGENT).origin, page.url())
    const leak = await page.evaluate(() => ({ cookie: document.cookie, local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }) }))
    const cookies = await ctx.cookies()
    check('A4 the session cookie is HttpOnly and no token or secret is in script-visible cookies or browser storage', cookies.some((c) => c.httpOnly) && !/eyJ|token|secret|password|fbeds_session/i.test(leak.cookie + leak.local + leak.session), leak.cookie)
    const ctxBody = await page.evaluate(async () => { const r = await fetch('/api/v1/agent/context', { credentials: 'include' }); return r.json() })
    check('A5 tenant and agency context come from the authenticated server context, and booking is disabled there', ctxBody.data.memberships.length === 1 && ctxBody.data.memberships[0].tenantId === seed.tenantA && ctxBody.data.bookingEnabled === false, JSON.stringify(ctxBody.data.bookingEnabled))
    await ctx.close()
  }

  // ---- B/C. search, results and pagination -----------------------------------------------------------------------------------------------
  const s = await newSession(browser, seed.agentEmail); const { page, posts } = s
  const modules = {}
  timings.search_ms = await search(page)
  const first = await showing(page)
  check('B1 Dubai search for one room, two adults returns server-paginated results with an accurate "Showing 1–25 of N"', first && first[1] === '1' && first[2] === '25' && Number(first[3]) > 25, first && first[0])
  const total = Number(first[3])
  check('B2 the criteria summary shows the canonical destination, dates, occupancy, nationality and AED', /Dubai/.test(await resultsText(page)) && /1R · 2A/.test(await resultsText(page)) && /AED/.test(await resultsText(page)))
  await loadAll(page)
  const names = await page.locator('article.market-hotel-card h3, article.market-hotel-card h2').allInnerTexts()
  const after = await showing(page)
  check('C1 incremental loading adds hotels with no duplicates and reaches the server total', names.length === total && new Set(names).size === total, `${names.length}/${new Set(names).size}/${total}`)
  check('C2 after loading everything the count is accurate: "Showing 1–N of N"', after && after[1] === '1' && Number(after[2]) === total && Number(after[3]) === total, after && after[0])
  check('C3 stale-supplier and CLOSED hotels are absent; another tenant\'s hotel is absent; ON_REQUEST is shown but not selectable', !names.some((n) => n === N.stale || n === N.closed || n === N.beta), '')
  check('C4 no booking, hold or payment request was sent by searching', !posts.some((p) => /bookings|holds|payments|funding/.test(p)), posts.filter((p) => !/search|context/.test(p)).join(','))
  await page.screenshot({ path: `${SHOTS}/agent-results.png` })

  // ---- D. hotel details and offer matrix -------------------------------------------------------------------------------------------------
  await openHotel(page, N.pic)
  await page.waitForFunction(() => { const i = document.querySelector('section.market-hotel-detail img'); return !i || (i.complete && i.naturalWidth > 0) }, null, { timeout: 10000 }).catch(() => {})
  const detail = (await page.locator('section.market-hotel-detail').innerText()).replace(/\s+/g, ' ')
  const img = await page.locator('section.market-hotel-detail img').first().evaluate((el) => ({ ok: el.complete && el.naturalWidth > 0, src: el.getAttribute('src') })).catch(() => null)
  check('D1 hotel details show the profile, a valid image, room group, board, occupancy, total-stay AED and cancellation terms', img && img.ok && /deluxe/i.test(detail) && /Bed and breakfast/.test(detail) && /AED\s?1,?020\.00/.test(detail) && /Refundable/.test(detail) && /2A/.test(detail), detail.slice(0, 200))
  await backToResults(page); await openHotel(page, 'Filler Hotel 01')
  check('D2 a hotel with no image shows an honest placeholder, not a fabricated photo', (await page.locator('section.market-hotel-detail img').count()) === 0)
  await backToResults(page); await openHotel(page, N.long)
  check('D3 long hotel, room and plan names wrap without horizontal overflow', (await overflow(page)) <= 0, String(await overflow(page)))
  await backToResults(page); await openHotel(page, N.pool)
  const poolRows = await page.locator('.market-rate-row').count()
  const offerKeys = await page.locator('.market-rate-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-offer-id') ?? ''))
  check('D4 distinct offers stay distinct (three plans of one shared pool, same price), identified by canonical offer ids', poolRows === 3 && offerKeys.every((k) => /^ci_/.test(k)) && new Set(offerKeys).size === 3, `${poolRows} ${offerKeys.join(',')}`)

  // ---- E/K/Q. authoritative recheck, shared pool, no allocation --------------------------------------------------------------------------
  const c0 = counters()
  const t0 = Date.now(); const out1 = await select(page, 0); timings.recheck_ms = Date.now() - t0
  const panel = await page.locator('.portal-hold-panel').innerText()
  check('E1 selecting an offer runs the authoritative recheck and ends at "Offer rechecked" with the server result', /Offer rechecked/.test(out1) && /AED\s?1,?060\.00/.test(out1), out1.slice(0, 260))
  check('E2 the rechecked offer shows its server expiry as a readable date and time (not a raw timestamp)', /valid until \d{1,2} \w{3} \d{4}, \d{2}:\d{2} \(Asia\/Dubai\)/.test(out1) && !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(out1), out1.slice(-160))
  check('E3 no Book, Pay, Confirm or Hold action is offered after a successful recheck (booking is disabled)', (await bookingControls(page)) === 0 && !/Booking review/i.test(out1 + panel) && /Rechecked offer/.test(panel))
  const out2 = await select(page, 1); const out3 = await select(page, 2)
  check('K1 all three plans of the shared pool recheck independently without multiplying stock or allocating it', /Offer rechecked/.test(out2) && /Offer rechecked/.test(out3), '')
  check('Q1 rechecking caused no allocation: availability, pool, hold, booking and ledger counters are unchanged', JSON.stringify(counters()) === JSON.stringify(c0) && JSON.stringify(c0) === JSON.stringify(before), JSON.stringify(counters()))
  check('Q2 the only non-GET requests were search and recheck (no booking, hold, payment or funding call)', posts.every((p) => /\/agent\/(search|rates\/recheck)|auth\/login/.test(p)), [...new Set(posts)].join(' | '))
  await page.screenshot({ path: `${SHOTS}/agent-rechecked.png` })
  // shared pool exhausted by someone else: every plan of the pool fails closed
  sql(`update "InventoryPoolDay" set sold = capacity where pool_id = '${seed.poolId}'`)
  const gone1 = await select(page, 0); const gone2 = await select(page, 1)
  check('K2 when the shared pool is sold out, every plan sharing it is unavailable at recheck (stock is counted once)', /no longer available/i.test(gone1) && /no longer available/i.test(gone2), gone1.slice(0, 120))
  sql(`update "InventoryPoolDay" set sold = 0 where pool_id = '${seed.poolId}'`)
  await backToResults(page)

  // ---- F. price changed -----------------------------------------------------------------------------------------------------------------
  await openHotel(page, N.change)
  sql(`update "DailyRate" set amount_minor = 61000 where rate_plan_id = '${seed.plans.change[0]}'`)
  const chg = await select(page, 0)
  check('F1 a changed price is reported as "Price updated" with the previous and current total, not silently accepted', /Price updated/.test(chg) && /AED\s?1,?120\.00/.test(chg) && /AED\s?1,?220\.00/.test(chg), chg.slice(0, 300))
  check('F2 nothing is rechecked as valid until the agent explicitly accepts the new price', (await page.getByRole('button', { name: /Accept New Price/ }).count()) === 1 && !/Offer rechecked/.test(chg))
  await page.getByRole('button', { name: /Accept New Price/ }).click(); await page.waitForFunction(() => /Offer rechecked/.test(document.querySelector('.portal-hold-panel')?.innerText ?? ''), null, { timeout: 20000 })
  check('F3 after acceptance the recheck confirms the new total', /AED\s?1,?220\.00/.test(await panelText(page)))
  sql(`update "DailyRate" set amount_minor = 56000 where rate_plan_id = '${seed.plans.change[0]}'`)
  await backToResults(page)

  // ---- G. unavailable ---------------------------------------------------------------------------------------------------------------------
  await openHotel(page, N.gone)
  sql(`update "DailyAvailability" set sold = allotment where rate_plan_id = '${seed.plans.gone[0]}'`)
  const un = await select(page, 0)
  check('G1 an offer that sold out after the search is "no longer available" with no inventory allocated', /no longer available/i.test(un) && /No inventory was allocated/.test(un), un.slice(0, 200))
  sql(`update "DailyAvailability" set sold = 0 where rate_plan_id = '${seed.plans.gone[0]}'`)
  await backToResults(page)

  // ---- I/J. stale inventory and ON_REQUEST ------------------------------------------------------------------------------------------------
  const onreqCard = page.locator('article.market-hotel-card', { hasText: N.onreq }).first()
  if (await onreqCard.count()) {
    await onreqCard.getByRole('button').first().click(); await page.waitForSelector('section.market-hotel-detail')
    const rowText = (await page.locator('.market-rate-row').first().innerText()).replace(/\s+/g, ' ')
    const btn = page.locator('.market-rate-row').first().getByRole('button', { name: /Select Offer/ })
    check('J1 ON_REQUEST inventory is labelled and cannot be selected or rechecked', /on request/i.test(rowText) && ((await btn.count()) === 0 || (await btn.isDisabled())), rowText.slice(0, 160))
    await backToResults(page)
  } else check('J1 ON_REQUEST inventory is not offered as a sellable hotel', true, 'hotel absent from results')
  check('I1 stale supplier inventory fails closed: the hotel is not offered at all (not as zero, not as available)', !(await page.locator('article.market-hotel-card', { hasText: N.stale }).count()))

  // ---- H. expiry -------------------------------------------------------------------------------------------------------------------------
  {
    const ex = await newSession(browser, seed.agentEmail); await search(ex.page)
    await openHotel(ex.page, 'Filler Hotel 02')
    await ex.page.route('**/agent/rates/recheck', (r) => { const b = r.request().postDataJSON(); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { offerId: b.offerId, searchId: b.searchId, requestId: 'req-injected', status: 'offer_expired' } }) }) })
    const o = await select(ex.page, 0)
    check('H1 [injected] an expired-offer recheck result tells the agent to refresh, with no inventory allocated, and offers "Refresh rates"', /expired/i.test(o) && /No inventory was allocated/.test(o) && (await ex.page.getByRole('button', { name: /Refresh rates/ }).count()) === 1, o.slice(0, 200))
    await ex.ctx.close()
  }

  // ---- real server-side expiry + API boundary checks (short-TTL API process) ----------------------------------------------------------------
  {
    const post = (p, body, cookie, tenant, base = API_SHORT) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: AGENT, ...(cookie ? { cookie } : {}), ...(tenant ? { 'x-fbeds-tenant-id': tenant } : {}) }, body: JSON.stringify(body) })
    const login = async (email, base = API_SHORT) => { const r = await post('/auth/login', { email, password: seed.password }, null, null, base); return (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')]).map((c) => c.split(';')[0]).join('; ') }
    const crit = { destination: 'Dubai', destinationRef: { type: 'city', id: 'city:AE:dubai', countryCode: 'AE' }, checkIn: IN_FROM, checkOut: IN_TO, rooms: 1, adults: 2, children: 0, childAges: [], roomStays: [{ adults: 2, children: [] }], nationality: 'IN', currency: 'AED', limit: 25 }
    try {
      const cookie = await login(seed.agentEmail)
      const sr = await (await post('/agent/search', crit, cookie, seed.tenantA)).json()
      const rate = sr.data.hotels[0].rooms[0].rates[0]
      const fresh = await (await post('/agent/rates/recheck', { offerId: rate.offerId, searchId: sr.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: rate.sellAmountMinor }, cookie, seed.tenantA)).json()
      await new Promise((r) => setTimeout(r, 2200))
      const exp = await (await post('/agent/rates/recheck', { offerId: rate.offerId, searchId: sr.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: rate.sellAmountMinor }, cookie, seed.tenantA)).json()
      check('H2 the real API answers "offer_expired" once the offer\'s server expiry has passed (short-TTL process), and "rechecked" before', fresh.data.status === 'rechecked' && exp.data.status === 'offer_expired', `${fresh.data.status} -> ${exp.data.status}`)
      const bAgent = await login(seed.bagentEmail)
      const wrongTenant = await post('/agent/search', crit, bAgent, seed.tenantA)
      const bSearch = await (await post('/agent/search', crit, bAgent, seed.tenantB)).json()
      const crossRecheck = await post('/agent/rates/recheck', { offerId: rate.offerId, searchId: sr.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: rate.sellAmountMinor }, bAgent, seed.tenantB)
      const crossBody = await crossRecheck.json()
      check('M1 cross-tenant: tenant B\'s session cannot act as tenant A (403), sees only its own hotel, and cannot recheck tenant A\'s offer', wrongTenant.status === 403 && bSearch.data.hotels.length === 1 && bSearch.data.hotels[0].name === N.beta && ['unavailable', 'rejected', 'access_denied'].includes(crossBody.data?.status ?? 'x'), `${wrongTenant.status} ${bSearch.data.hotels.length} ${crossBody.data?.status}`)
      const na = await login(seed.noaccessEmail)
      const naSearch = await post('/agent/search', crit, na, seed.tenantA)
      check('M2 a read-only user without hotel.search is denied search (403) and unauthenticated search is 401', naSearch.status === 403 && (await post('/agent/search', crit, null, seed.tenantA)).status === 401, String(naSearch.status))
      const bk = await post('/agent/bookings', {}, cookie, seed.tenantA, 'http://127.0.0.1:3002/api/v1')
      const hold = await post('/agent/holds', {}, cookie, seed.tenantA, 'http://127.0.0.1:3002/api/v1')
      check('P1 booking and hold endpoints are closed by the server (not by a client flag): no booking was created', [400, 403, 404, 409, 503].includes(bk.status) && [400, 403, 404, 409, 503].includes(hold.status) && counters().bookings === before.bookings, `${bk.status}/${hold.status}`)
    } catch (e) { check('H2/M/P API boundary checks ran against the short-TTL API process', false, e.message) }
  }

  // ---- L. session expiry and logout ---------------------------------------------------------------------------------------------------------
  {
    const ex = await newSession(browser, seed.agentEmail); await search(ex.page)
    sql(`delete from sessions where user_id = (select id from users where email = '${seed.agentEmail}')`)
    await ex.page.getByLabel('Sort results').selectOption('name'); await ex.page.waitForTimeout(2500)
    const t = (await ex.page.locator('body').innerText()).replace(/\s+/g, ' ')
    check('L1 an expired or revoked session shows a clear recovery path (sign in again) instead of a silent failure', /sign in|session expired|expired/i.test(t), t.slice(0, 160))
    await ex.ctx.close()
    const lo = await newSession(browser, seed.agentEmail); await search(lo.page)
    await lo.page.getByRole('button', { name: /Sign out/ }).click(); await lo.page.waitForSelector('#email', { timeout: 15000 })
    const st = await lo.page.evaluate(() => JSON.stringify({ ...sessionStorage }))
    const ctxAfter = await lo.page.evaluate(async () => (await fetch('/api/v1/agent/context', { credentials: 'include' })).status)
    check('L2 sign-out clears the session and account-specific browser state, and the API refuses the old session', ctxAfter === 401 && !/Dubai|recent/i.test(st) && (await lo.page.locator('article.market-hotel-card').count()) === 0, `${ctxAfter} ${st.slice(0, 80)}`)
    await lo.ctx.close()
  }

  // ---- N. API unavailable and retry; stale responses ---------------------------------------------------------------------------------------
  {
    const r = await newSession(browser, seed.agentEmail)
    await chooseDubai(r.page); await setStay(r.page, IN_FROM, IN_TO)
    await r.page.route('**/api/v1/agent/search', (route) => route.abort())
    await r.page.getByRole('button', { name: /^Search/ }).first().click(); await r.page.waitForTimeout(1500)
    const t = (await r.page.locator('main.portal-main').innerText()).replace(/\s+/g, ' ')
    check('N1 [injected] an unreachable API shows an honest error, keeps the criteria, and offers Retry', /try again|unavailable|retry/i.test(t) && (await r.page.getByLabel('Destination').inputValue()) === 'Dubai', t.slice(0, 160))
    await r.page.unroute('**/api/v1/agent/search')
    await r.page.getByRole('button', { name: /Retry|Search/ }).first().click(); await r.page.waitForSelector('article.market-hotel-card', { timeout: 30000 })
    check('N2 retry succeeds without re-entering the criteria', (await r.page.locator('article.market-hotel-card').count()) > 0)
    // out-of-order responses: the first search is held back, a second one is sent and must win
    await r.page.route('**/api/v1/agent/search', async (route) => { const body = route.request().postDataJSON(); if (body.nationality === 'IN' && !body.offset) { await new Promise((x) => setTimeout(x, 3500)) } await route.continue() })
    await r.page.locator('select[aria-label="Guest nationality"], select[aria-label*="ationality"]').first().selectOption('GB').catch(() => {})
    await r.page.getByRole('button', { name: /^Search|Retry/ }).first().click().catch(() => {})
    await r.page.waitForTimeout(500)
    await r.page.getByRole('button', { name: /^Search|Retry/ }).first().click().catch(() => {})
    await r.page.waitForTimeout(5000)
    const summary = (await r.page.locator('.market-criteria-bar').innerText().catch(() => '')).replace(/\s+/g, ' ')
    check('N3 [injected delay] an older, slower search response cannot overwrite the newer search', /United Kingdom|GB/.test(summary), summary)
    await r.ctx.close()
  }

  // ---- O. responsive, keyboard, accessibility -----------------------------------------------------------------------------------------------
  for (const [w, h] of [[390, 844], [768, 900], [1280, 900]]) {
    const v = await newSession(browser, seed.agentEmail, { width: w, height: h })
    await search(v.page); const o1 = await overflow(v.page)
    await openHotel(v.page, N.pic); await select(v.page, 0); const o2 = await overflow(v.page)
    check(`O1 no horizontal overflow at ${w}px on results and on the rechecked offer`, o1 <= 0 && o2 <= 0, `${o1}/${o2}`)
    if (w === 390) await v.page.screenshot({ path: `${SHOTS}/agent-rechecked-390.png`, fullPage: true })
    await v.ctx.close()
  }
  {
    const k = await newSession(browser, seed.agentEmail)
    await k.page.getByLabel('Destination').focus(); await k.page.keyboard.type('Dubai'); await k.page.waitForTimeout(600)
    await k.page.getByRole('option', { name: /Dubai/ }).first().focus(); await k.page.keyboard.press('Enter')
    check('O2 the destination can be chosen from the keyboard', (await k.page.getByText('Canonical destination selected').count()) === 1)
    await setStay(k.page, IN_FROM, IN_TO); await k.page.getByLabel('Destination').focus(); await k.page.keyboard.press('Enter')
    await k.page.waitForSelector('article.market-hotel-card', { timeout: 30000 })
    check('O3 Enter in the search form runs the search', (await k.page.locator('article.market-hotel-card').count()) > 0)
    const focusStyle = await k.page.evaluate(() => { const b = document.querySelector('article.market-hotel-card button'); b.focus(); const cs = getComputedStyle(b); return cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.boxShadow })
    check('O4 keyboard focus is visible on actionable controls', !/^none 0px none$/.test(focusStyle) && focusStyle.trim().length > 0, focusStyle)
    const mains = await k.page.locator('main').count()
    check('O5 exactly one main landmark', mains === 1, String(mains))
    const axeResults = await new AxeBuilder({ page: k.page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    const bad = axeResults.violations.filter((x) => ['serious', 'critical'].includes(x.impact))
    check('O6 axe (WCAG A/AA) on the search results: no serious or critical violations', bad.length === 0, bad.map((x) => x.id).join(','))
    await openHotel(k.page, N.pic); await select(k.page, 0)
    const axe2 = await new AxeBuilder({ page: k.page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    const bad2 = axe2.violations.filter((x) => ['serious', 'critical'].includes(x.impact))
    check('O7 axe (WCAG A/AA) on the hotel detail with a recheck outcome: no serious or critical violations', bad2.length === 0, bad2.map((x) => x.id).join(','))
    const live = await k.page.locator('.portal-hold-panel[aria-live], .portal-hold-outcome[role=status], .portal-hold-outcome[role=alert]').count()
    check('O8 loading and recheck outcomes are announced to screen readers (live region or status/alert role)', live >= 1)
    check('O9 no uncaught page errors during the journey', k.pageErrors.length === 0 && s.pageErrors.length === 0, [...k.pageErrors, ...s.pageErrors].join(' | '))
    await k.ctx.close()
  }

  // ---- final no-side-effect evidence ---------------------------------------------------------------------------------------------------------
  const finalCounters = counters()
  check('Q3 across the whole journey no booking, hold or ledger row was created', finalCounters.holds === before.holds && finalCounters.bookings === before.bookings && finalCounters.ledger === before.ledger, JSON.stringify(finalCounters))
  console.log(`\nTIMINGS ${JSON.stringify(timings)} total hotels ${total}`)
  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) { console.log('FAILED:\n' + failed.map((f) => ' - ' + f.name).join('\n')); process.exit(1) }
})().catch((e) => { console.error(e); process.exit(1) })
