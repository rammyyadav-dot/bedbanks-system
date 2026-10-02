// Real-stack browser verification of the hotel commercial workspace. See README.md. Not run in CI.
const path = require('path')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const AxeBuilder = req('@axe-core/playwright').default || req('@axe-core/playwright')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-hotels.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const SHOTS = process.env.SHOT_DIR ?? require('os').tmpdir()
const H = seed.hotels
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 160) : ''}`) }
const text = async (page) => (await page.locator('main, .admin-page').first().innerText()).replace(/\s+/g, ' ')
const stateOf = async (page) => page.locator('[data-state]').first().getAttribute('data-state')
const rows = (page) => page.locator('[data-testid=hotels-table] tbody tr').count()

async function login(browser, email, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport } : {}); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
async function openHotel(page, key, tab) {
  await page.goto(`${BASE}/hotels/${H[key]}${tab ? `?tab=${tab}` : ''}`)
  await page.waitForSelector('[data-testid=hotel-header], [data-state]', { timeout: 20000 })
}

;(async () => {
  const browser = await chromium.launch()
  const { ctx, page } = await login(browser, seed.ownerEmail)
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))

  // ---- list: summary, server pagination, search, filters, shareable URLs -------------------------------------------------
  await page.goto(`${BASE}/hotels`); await page.waitForSelector('[data-testid=hotels-table]', { timeout: 20000 }); await page.waitForSelector('[data-testid=hotels-summary]')
  const summary = (await page.locator('[data-testid=hotels-summary]').innerText()).replace(/\s+/g, ' ')
  check('summary shows tenant-wide total (34) from the API', /34 Total hotels/.test(summary), summary.slice(0, 120))
  check('page 1 shows 25 rows', (await rows(page)) === 25)
  check('pager reports total and page', /34 results · page 1 of 2/.test(await page.locator('[data-testid=pager]').innerText()))
  await page.getByRole('button', { name: 'Next page' }).click(); await page.waitForFunction(() => location.search.includes('page=2'))
  await page.waitForSelector('[data-testid=hotels-table] tbody tr'); await page.waitForTimeout(400)
  check('page 2 (final) shows the remaining 9 rows and the URL carries the page', (await rows(page)) === 9 && page.url().includes('page=2'))
  await page.screenshot({ path: `${SHOTS}/hotels-list.png`, fullPage: true })
  await page.goto(`${BASE}/hotels?search=Atlantis`); await page.waitForSelector('[data-testid=hotels-table]')
  check('search by name (server-side, shareable URL)', (await rows(page)) === 1 && /Atlantis Palm Resort/.test(await text(page)))
  await page.goto(`${BASE}/hotels?search=${encodeURIComponent('ALPHA-' + seed.tag.slice(-4))}`); await page.waitForSelector('[data-testid=hotels-table]')
  check('search by hotel code', (await rows(page)) === 1)
  await page.goto(`${BASE}/hotels?search=%25`); await page.waitForSelector('[data-state=empty], [data-testid=hotels-table]')
  check('a "%" search is literal and matches nothing', (await stateOf(page)) === 'empty')
  await page.goto(`${BASE}/hotels`); await page.waitForSelector('[data-testid=hotels-table]')
  await page.getByLabel('Destination').selectOption('Abu Dhabi'); await page.waitForFunction(() => location.search.includes('destination'))
  await page.waitForTimeout(500)
  check('destination filter', (await rows(page)) === 1 && /Corniche Abu Dhabi Hotel/.test(await text(page)))
  for (const [qs, label, expectName, expectCount] of [['readiness=BLOCKED', 'readiness=BLOCKED', 'Deira Gate Hotel', null], ['readiness=PARTIAL', 'readiness=PARTIAL', 'Burj View Hotel', null], ['mapping=NONE', 'mapping=NONE', 'Karama Budget Stay', 1], ['contractState=EXPIRING', 'contract EXPIRING', 'Jumeirah Beach Club', 1], ['contractState=EXPIRED', 'contract EXPIRED', 'Emirates Old Town', 1], ['expiresWithinDays=30', 'expires within 30d', 'Jumeirah Beach Club', 1], ['issue=STOP_SELL', 'issue=STOP_SELL', 'Hatta Mountain Lodge', null], ['issue=RATE_MISSING', 'issue=RATE_MISSING', 'Festival City Suites', 1], ['issue=AVAILABILITY_MISSING', 'issue=AVAILABILITY_MISSING', 'Gold Souk Residence', 1], ['issue=NO_INVENTORY', 'issue=NO_INVENTORY', 'Marina Bay Towers', 1], ['mapping=PENDING', 'mapping=PENDING', 'Creek Harbour Inn', 1]]) {
    await page.goto(`${BASE}/hotels?${qs}`); await page.waitForSelector('[data-testid=hotels-table], [data-state]')
    const body = await text(page); const n = await rows(page)
    check(`filter ${label} (server-side)`, body.includes(expectName) && (expectCount === null || n === expectCount), `${n} rows`)
  }
  await page.goto(`${BASE}/hotels?readiness=BLOCKED`); await page.waitForSelector('[data-testid=hotels-table]')
  const chips = await page.locator('[data-testid=hotels-table] tbody tr td:nth-child(9)').allInnerTexts()
  check('every row of the BLOCKED filter shows a BLOCKED chip', chips.length > 0 && chips.every((c) => /BLOCKED/.test(c)), chips.join(','))
  await page.goto(`${BASE}/hotels?search=zzzzzzzz`); await page.waitForSelector('[data-state=empty]')
  check('no match is the EMPTY state with a successful message, not an error', /No hotels match these filters/.test(await text(page)) && (await page.locator('[role=alert]:not(#__next-route-announcer__)').count()) === 0)

  // ---- failure states are distinct and never an empty list -----------------------------------------------------------------
  for (const [status, code, expect, label] of [[401, 'UNAUTHORIZED', 'unauthenticated', '401'], [403, 'FORBIDDEN', 'forbidden', '403'], [503, 'OPERATIONS_READ_DENIED', 'denied', '503 denied'], [500, 'INTERNAL_SERVER_ERROR', 'error', '500']]) {
    await page.route('**/api/v1/admin/operations/hotels?*', (r) => r.fulfill({ status, contentType: 'application/json', headers: { 'x-request-id': 'req-hotels-1' }, body: JSON.stringify({ success: false, error: { code, message: 'x', details: [] }, meta: {} }) }))
    await page.goto(`${BASE}/hotels`); await page.waitForSelector('[data-state]', { timeout: 15000 })
    const state = await stateOf(page); const body = await text(page)
    check(`list API ${label} renders "${expect}" and never "No hotels"`, state === expect && !/No hotels/.test(body) && /req-hotels-1|HTTP/.test(body), `${state}`)
    await page.unroute('**/api/v1/admin/operations/hotels?*')
  }
  await page.route('**/api/v1/admin/operations/hotels?*', (r) => r.abort()); await page.goto(`${BASE}/hotels`); await page.waitForSelector('[data-state]', { timeout: 15000 })
  check('network failure renders "unreachable"', (await stateOf(page)) === 'unreachable'); await page.unroute('**/api/v1/admin/operations/hotels?*')
  await page.route('**/api/v1/admin/operations/hotels/summary*', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'OPERATIONS_READ_DENIED', message: 'x', details: [] }, meta: {} }) }))
  await page.goto(`${BASE}/hotels`); await page.waitForSelector('[data-testid=hotels-table]')
  check('a failed summary does not hide the list, and says it is unavailable', (await page.locator('[data-testid=summary-unavailable]').count()) === 1 && (await rows(page)) === 25); await page.unroute('**/api/v1/admin/operations/hotels/summary*')

  // ---- Hotel 360 -------------------------------------------------------------------------------------------------------------
  await openHotel(page, 'alpha')
  let header = (await page.locator('[data-testid=hotel-header]').innerText()).replace(/\s+/g, ' ')
  check('READY hotel: header shows READY, Sellable to Agents YES, supplier, code and canonical id', /READY/.test(header) && /Sellable to Agents\s*YES/.test(header) && /Gulf Direct/.test(header) && header.includes(H.alpha) && /ALPHA-/.test(header), header.slice(0, 140))
  const gates = await page.locator('[data-testid=readiness-gates] li').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))
  check('READY hotel: all 12 readiness gates PASS', gates.length === 12 && gates.every((g) => g === 'PASS'), gates.join(','))
  check('READY hotel: no commercial issues', (await page.locator('[data-testid=issues-empty]').count()) === 1)
  await page.screenshot({ path: `${SHOTS}/hotel-360-overview.png`, fullPage: true })

  await openHotel(page, 'bravo')
  header = (await page.locator('[data-testid=hotel-header]').innerText()).replace(/\s+/g, ' ')
  check('PARTIAL hotel: header shows PARTIAL and issues list names STOP_SELL', /PARTIAL/.test(header) && (await page.locator('[data-testid=issue-list] [data-category=STOP_SELL]').count()) === 1)
  await page.locator('[data-testid=issue-list] [data-category=STOP_SELL] a').first().click(); await page.waitForURL(/tab=rates/); await page.waitForSelector('[data-testid=calendar]')
  check('an issue links to the section that resolves it, at the affected night and room (Rates & Inventory)', /tab=rates/.test(page.url()) && /from=\d{4}-\d{2}-\d{2}/.test(page.url()) && /roomTypeId=/.test(page.url()), page.url().slice(-110))
  const stopCell = page.locator('[data-testid=calendar] tr[data-sellable=false]').first()
  check('calendar marks the stop-sold night NOT SELLABLE with the canonical reason', (await stopCell.count()) === 1 && /STOP_SELL/.test(await stopCell.innerText()) && /STOP SELL/.test(await stopCell.innerText()))
  const calText = await page.locator('[data-testid=calendar]').innerText()
  check('calendar shows integer-minor rates as currency (AED 499.00) and remaining inventory', /AED\s?499\.00/.test(calText) && /\b6\b/.test(calText), calText.slice(0, 120))
  await page.screenshot({ path: `${SHOTS}/hotel-360-calendar.png`, fullPage: true })

  await openHotel(page, 'charlie')
  check('mapping-pending hotel: CRITICAL UNMAPPED_HOTEL issue with canonical reason', (await page.locator('[data-testid=issue-list] [data-category=UNMAPPED_HOTEL][data-severity=CRITICAL]').count()) >= 1)
  await page.locator('[data-testid=issue-list] [data-category=UNMAPPED_HOTEL] a').first().click(); await page.waitForURL(/tab=mappings/); await page.waitForSelector('table, [data-testid=hotel-mapping-empty]')
  check('mapping tab shows the PENDING supplier mapping and the unmapped rooms (never inferred)', /PENDING/.test(await text(page)) && (await page.locator('[data-testid=unmapped-rooms] li').count()) === 2)

  await openHotel(page, 'delta', 'rooms'); await page.waitForSelector('[data-room-id]')
  check('room-mapping failure: rooms tab shows NOT MAPPED and BLOCKED with the canonical blocker', /NOT MAPPED/.test(await text(page)) && /SUPPLIER_MAPPING_INVALID/.test(await text(page)))
  await openHotel(page, 'echo', 'contracts'); await page.waitForSelector('[data-testid=sellability-chain]'); await page.waitForSelector('table')
  check('expired contract: contracts tab shows EXPIRED and a failed contract step in the chain', /EXPIRED/.test(await text(page)) && /Contract active\s*FAIL/.test(await page.locator('[data-testid=sellability-chain]').innerText().then((t) => t.replace(/\s+/g, ' '))))
  await openHotel(page, 'juliet', 'contracts'); await page.waitForSelector('table')
  check('expiring contract: shows EXPIRING and the days left', /EXPIRING/.test(await text(page)) && /21d|20d/.test(await text(page)))
  await openHotel(page, 'juliet')
  check('expiring contract appears as a WARNING issue', (await page.locator('[data-testid=issue-list] [data-category=CONTRACT_EXPIRING][data-severity=WARNING]').count()) === 1)
  await openHotel(page, 'kilo')
  check('brand-new hotel is BLOCKED with critical issues, never "ready"', /BLOCKED/.test(await page.locator('[data-testid=hotel-header]').innerText()) && (await page.locator('[data-testid=issue-list] [data-severity=CRITICAL]').count()) >= 2)

  // ---- sellability inspector --------------------------------------------------------------------------------------------------
  await openHotel(page, 'alpha', 'sellability')
  await page.getByRole('button', { name: 'Check sellability' }).click(); await page.waitForSelector('[data-testid=sellability-result]')
  let res = (await page.locator('[data-testid=sellability-result]').innerText()).replace(/\s+/g, ' ')
  check('sellable stay: SELLABLE, offers and the cheapest integer total (AED 1,497.00)', /SELLABLE/.test(res) && !/NOT SELLABLE\s+\d/.test(res.slice(0, 20)) && /Offers:\s*2/.test(res) && /AED\s?1,497\.00/.test(res), res.slice(0, 160))
  await page.screenshot({ path: `${SHOTS}/sellability-ok.png`, fullPage: true })
  await openHotel(page, 'bravo', 'sellability')
  // the seeded stop-sell is on the 15th day from today for the Deluxe plan; stay nights d+14..d+16
  const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  await page.getByLabel('Check-in').fill(day(14)); await page.getByLabel('Check-out').fill(day(17))
  await page.getByRole('button', { name: 'Check sellability' }).click(); await page.waitForSelector('[data-testid=sellability-result]')
  const bad = page.locator('[data-testid=sellability-result] section[data-sellable=false]').first()
  const badText = (await bad.innerText()).replace(/\s+/g, ' ')
  check('multi-night failure: the Deluxe plan is NOT SELLABLE, names STOP_SELL and the failing night', (await bad.count()) === 1 && /STOP_SELL/.test(badText) && (await bad.locator(`li[data-date="${day(15)}"][data-sellable=false]`).count()) === 1 && (await bad.locator(`li[data-date="${day(14)}"][data-sellable=true]`).count()) === 1, badText.slice(0, 140))
  check('failed gate list shows Stop sell FAIL and Daily rate PASS', (await bad.locator('li[data-gate=stopSell][data-state=FAIL]').count()) === 1 && (await bad.locator('li[data-gate=rate][data-state=PASS]').count()) === 1)
  check('the other room stays sellable for the same dates (per-plan verdicts)', (await page.locator('[data-testid=sellability-result] section[data-sellable=true]').count()) === 1)
  await page.getByLabel('Check-out').fill(day(14)); await page.getByRole('button', { name: 'Check sellability' }).click(); await page.waitForSelector('[data-state]')
  check('an invalid stay shows the API validation message, not a result', /1-31 nights/.test(await text(page)) && (await page.locator('[data-testid=sellability-result]').count()) === 0)
  await page.screenshot({ path: `${SHOTS}/sellability-failed.png`, fullPage: true })
  let posts = 0; page.on('request', (r) => { if (r.url().includes('/sellability')) posts++ })
  await page.getByLabel('Check-out').fill(day(16)); await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Check sellability/.test(x.textContent)); b.click(); b.click() })
  await page.waitForSelector('[data-testid=sellability-result]'); check('a double click sends one inspection request', posts === 1, `requests=${posts}`)

  // ---- bookings, holds, audit cross-navigation ----------------------------------------------------------------------------------
  await openHotel(page, 'alpha', 'bookings'); await page.waitForSelector('table')
  check('bookings tab lists the hotel booking with a link into Booking 360', (await page.locator('a[href^="/bookings/"]').count()) >= 1 && /BK1/.test(await text(page)))
  await page.getByRole('link', { name: 'All bookings for this hotel' }).click(); await page.waitForURL(/\/bookings\?hotelId=/); await page.waitForSelector('table')
  check('"All bookings" opens the booking list already filtered by this hotel (server-side)', /1 result/.test(await text(page)) && (await page.getByLabel('Hotel id').inputValue()) === H.alpha)
  await openHotel(page, 'alpha', 'audit'); await page.waitForSelector('table')
  check('audit tab shows the event with action and request id', /supply\.hotel\.updated/.test(await text(page)) && /req-verify-1/.test(await text(page)))

  // ---- exceptions ---------------------------------------------------------------------------------------------------------------
  await page.goto(`${BASE}/exceptions`); await page.waitForSelector('[data-testid=exceptions-table]')
  const counts = await page.locator('[data-testid=exception-counts]').innerText()
  check('exceptions centre lists issues with severity counts', /\d+ critical · \d+ high · \d+ warning/.test(counts) && (await page.locator('[data-testid=exceptions-table] tbody tr').count()) > 5, counts)
  const firstSeverity = await page.locator('[data-testid=exceptions-table] tbody tr').first().getAttribute('data-severity')
  check('exceptions are ordered most severe first', firstSeverity === 'CRITICAL')
  await page.getByLabel('Severity').selectOption('WARNING'); await page.waitForTimeout(600); await page.waitForSelector('[data-testid=exceptions-table]')
  const sev = await page.locator('[data-testid=exceptions-table] tbody tr').evaluateAll((els) => els.map((e) => e.getAttribute('data-severity')))
  check('severity filter applies on the server', sev.length > 0 && sev.every((s) => s === 'WARNING'), sev.join(','))
  await page.getByLabel('Severity').selectOption(''); await page.getByLabel('Category').selectOption('RATE_MISSING'); await page.waitForTimeout(600)
  await page.locator('[data-testid=exceptions-table] tbody tr a', { hasText: 'Resolve in' }).first().click(); await page.waitForURL(/\/hotels\/.+\?tab=rates/)
  check('an exception links to the exact hotel section to resolve it', /tab=rates/.test(page.url()))
  await page.screenshot({ path: `${SHOTS}/exceptions.png`, fullPage: true })

  // ---- Add Hotel never implies "ready": a hotel created through the real form is BLOCKED until downstream authority exists -------------
  await page.goto(`${BASE}/hotels/new`); await page.waitForSelector('form')
  await page.getByLabel(/^name$/i).fill('Brand New Verification Hotel'); await page.getByLabel(/^city$/i).fill('Dubai'); await page.getByLabel(/^country code$/i).fill('AE'); await page.getByLabel(/^external ref$/i).fill('NEW-VERIFY-1')
  await page.getByRole('button', { name: 'Create hotel' }).click(); await page.waitForURL(/\/hotels\/[^/]+$/, { timeout: 20000 }); await page.waitForSelector('[data-testid=hotel-header]')
  const created = (await page.locator('[data-testid=hotel-header]').innerText()).replace(/\s+/g, ' ')
  check('a newly created hotel opens as BLOCKED, "Sellable to Agents NO", status DRAFT', /BLOCKED/.test(created) && /Sellable to Agents\s*NO/.test(created) && /DRAFT/.test(created), created.slice(0, 120))
  check('a newly created hotel lists RATE_PLAN_MISSING and an unmapped-hotel issue as critical', (await page.locator('[data-testid=issue-list] [data-severity=CRITICAL]').count()) >= 2 && /No rate plan is configured/.test(await text(page)))

  // ---- keyboard, responsive, accessibility ----------------------------------------------------------------------------------------
  await openHotel(page, 'alpha'); await page.locator('[role=tab]').first().focus(); await page.keyboard.press('Tab')
  const focusedRole = await page.evaluate(() => document.activeElement?.getAttribute('role'))
  await page.getByRole('tab', { name: 'Rooms' }).focus(); await page.keyboard.press('Enter'); await page.waitForURL(/tab=rooms/)
  check('tabs are keyboard reachable and activate with Enter', focusedRole === 'tab' && /tab=rooms/.test(page.url()))
  for (const [w, h] of [[1280, 900], [768, 900], [390, 800]]) {
    await page.setViewportSize({ width: w, height: h })
    for (const url of [`${BASE}/hotels`, `${BASE}/hotels/${H.alpha}?tab=rates`, `${BASE}/exceptions`]) {
      await page.goto(url); await page.waitForSelector('table, [data-state]'); await page.waitForTimeout(500)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      const focusable = await page.evaluate(() => [...document.querySelectorAll('[role=region][aria-label]')].every((r) => r.scrollWidth <= r.clientWidth + 1 || r.getAttribute('tabindex') === '0'))
      check(`no page-level horizontal overflow at ${w}px on ${new URL(url).pathname}${new URL(url).search}`, overflow <= 1 && focusable, `overflow=${overflow}`)
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await openHotel(page, 'bravo', 'sellability'); await page.getByRole('button', { name: 'Check sellability' }).click(); await page.waitForSelector('[data-testid=sellability-result]')
  for (const [label, url, wait] of [['Hotels list', `${BASE}/hotels`, '[data-testid=hotels-table]'], ['Hotel 360', `${BASE}/hotels/${H.alpha}`, '[data-testid=readiness-gates]'], ['Rate & Inventory', `${BASE}/hotels/${H.bravo}?tab=rates`, '[data-testid=calendar]'], ['Sellability Inspector', null, '[data-testid=sellability-result]'], ['Exceptions', `${BASE}/exceptions`, '[data-testid=exceptions-table]']]) {
    if (url) { await page.goto(url); await page.waitForSelector(wait) }
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
    check(`axe ${label}: no serious/critical violations`, bad.length === 0, bad.map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0].target.join(' ').slice(0, 60)}`).join(' | '))
  }
  check('no uncaught page errors', errors.length === 0, errors.join(' | '))
  await ctx.close()

  // ---- permissions and tenants -------------------------------------------------------------------------------------------------
  const v = await login(browser, seed.viewerEmail)
  await v.page.goto(`${BASE}/hotels`); await v.page.waitForSelector('[data-testid=hotels-table]')
  check('viewer (supply.hotels.read only) can use the list', (await rows(v.page)) === 25)
  await openHotel(v.page, 'alpha'); await v.page.waitForTimeout(1200)
  const tabNames = await v.page.locator('[role=tab]').allInnerTexts()
  check('viewer: tabs needing other permissions are hidden', !tabNames.some((t) => /Contracts|Mappings|Rates|Sellability|Audit|Bookings/.test(t)), tabNames.join(','))
  await v.page.goto(`${BASE}/hotels/${H.alpha}?tab=contracts`); await v.page.waitForSelector('[data-state]', { timeout: 15000 })
  check('viewer deep-linking to Contracts gets FORBIDDEN, not an empty tab', (await stateOf(v.page)) === 'forbidden')
  await v.ctx.close()
  const b = await login(browser, seed.bownerEmail)
  await b.page.goto(`${BASE}/hotels`); await b.page.waitForSelector('[data-testid=hotels-table]')
  check('tenant B sees only its own hotel', (await rows(b.page)) === 1 && /Other Tenant Hotel/.test(await text(b.page)) && !/Atlantis/.test(await text(b.page)))
  await b.page.goto(`${BASE}/hotels/${H.alpha}`); await b.page.waitForSelector('[data-state]', { timeout: 15000 })
  check("tenant B opening tenant A's hotel gets not-found", (await stateOf(b.page)) === 'not-found')
  await b.page.goto(`${BASE}/exceptions`); await b.page.waitForSelector('[data-testid=exceptions-table], [data-state]')
  check('tenant B exceptions never mention tenant A hotels', !/Atlantis|Burj|Creek/.test(await text(b.page)))
  await b.ctx.close()

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
