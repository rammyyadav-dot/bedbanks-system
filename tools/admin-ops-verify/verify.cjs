const path = require('path')
const { createRequire } = require('module')
// Playwright and axe are installed for the website workspace; reuse them rather than adding a dependency to Admin.
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const AxeBuilder = req('@axe-core/playwright').default || req('@axe-core/playwright')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

async function login(browser, email) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
const text = async (page) => (await page.locator('main, .admin-page').first().innerText()).replace(/\s+/g, ' ')

;(async () => {
  const browser = await chromium.launch()
  const { ctx, page } = await login(browser, seed.ownerEmail)
  const errors = []; page.on('pageerror', e => errors.push(e.message))

  // 1. every operations list view renders real data, with table headers and a pager
  for (const [path, mustContain] of [['/bookings', 'CONFIRMED'], ['/holds', 'HELD'], ['/cancellations', 'MATCH'], ['/finance/wallets', 'Available credit'], ['/finance/ledger', 'DEBIT'], ['/audit', 'booking.'], ['/connectors', 'api_key: configured'], ['/operations/hotels', 'BLOCKED|READY'], ['/reconciliation', 'Stalled hold|PREBOOK_EXPIRED']]) {
    await page.goto(`${BASE}${path}`); await page.waitForSelector('table, [data-state], .admin-empty', { timeout: 15000 })
    const t = await text(page)
    check(`${path} shows API data`, new RegExp(mustContain).test(t), t.slice(0, 90))
  }
  await page.goto(`${BASE}/connectors`); await page.waitForSelector('table')
  check('/connectors never renders the secret reference', !(await page.content()).includes('vault://never-shown'))
  await page.goto(`${BASE}/bookings`); await page.waitForSelector('table')
  check('/bookings lists only tenant A (3 bookings)', /3 results/.test(await text(page)), (await text(page)).match(/\d+ results?/)?.[0])
  await page.screenshot({ path: `${process.env.SHOT_DIR ?? require('os').tmpdir()}/admin-ops-shot-bookings.png`, fullPage: true })

  // 2. Booking 360
  await page.goto(`${BASE}/bookings/${seed.confirmedBookingId}`); await page.waitForSelector('[data-testid=booking-360]')
  const b360 = await text(page)
  check('Booking 360 shows ledger DEBIT, hold CONFIRMED and audit trail', /DEBIT/.test(b360) && /CONFIRMED/.test(b360) && /booking\.prebook\.succeeded/.test(b360))
  check('Booking 360 states supplier reference is not stored', /Not stored/.test(b360))
  check('Booking 360 money is formatted from minor units (AED 1,251.00)', /1,251\.00/.test(b360), b360.match(/AED[^ ]* ?[\d,.]+/)?.[0])
  await page.screenshot({ path: `${process.env.SHOT_DIR ?? require('os').tmpdir()}/admin-ops-shot-booking360.png`, fullPage: true })
  await page.goto(`${BASE}/bookings/${seed.stuckBookingId}`); await page.waitForSelector('[data-testid=booking-360]')
  check('Stuck booking shows an attention flag', /Needs attention/.test(await text(page)), (await text(page)).match(/PREBOOK_EXPIRED_UNRESOLVED|RECONCILIATION_REQUIRED/)?.[0])

  // 3. operations readiness numbers come from the API
  await page.goto(`${BASE}/operations`); await page.waitForSelector('text=Supply')
  const ops = await text(page)
  check('Readiness shows supply, transactions, connectors sections', /Supply/.test(ops) && /Transactions/.test(ops) && /Connectors/.test(ops))
  await page.screenshot({ path: `${process.env.SHOT_DIR ?? require('os').tmpdir()}/admin-ops-shot-operations.png`, fullPage: true })

  // 4. reconcile: confirmation step, duplicate-submit protection, result with request id
  await page.goto(`${BASE}/reconciliation`); await page.waitForSelector('table')
  await page.click('text=Run reconciliation…'); await page.waitForSelector('[data-testid=recon-confirm]')
  check('Reconcile requires an explicit confirmation step', true)
  let posts = 0; page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/reconciliation/run')) posts++ })
  // two synchronous clicks in one task: the second must be ignored by the in-flight guard
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent === 'Confirm and run'); b.click(); b.click() })
  await page.waitForSelector('[data-testid=recon-result]', { timeout: 20000 })
  check('Duplicate submit sends exactly one POST', posts === 1, `posts=${posts}`)
  const rr = await text(page)
  check('Result shows outcome and request id', /prebook_expired/.test(rr) && /Request id/.test(rr), rr.match(/Request id: \S+/)?.[0])
  await page.reload(); await page.waitForSelector('table, .admin-empty')
  check('Queue is empty after reconcile (success state, not error)', /Nothing to reconcile/.test(await text(page)))

  // 5. distinct failure states (network interception is test-only; the app has no mock path)
  for (const [status, code, expect, label] of [[401, 'UNAUTHORIZED', 'unauthenticated', '401'], [403, 'FORBIDDEN', 'forbidden', '403'], [503, 'OPERATIONS_READ_DENIED', 'denied', '503 privilege boundary'], [500, 'INTERNAL_SERVER_ERROR', 'error', '500']]) {
    await page.route('**/api/v1/admin/operations/bookings*', r => r.fulfill({ status, contentType: 'application/json', headers: { 'x-request-id': 'req-test-123' }, body: JSON.stringify({ success: false, error: { code, message: 'x', details: [] }, meta: {} }) }))
    await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-state]', { timeout: 15000 })
    const state = await page.locator('[data-state]').first().getAttribute('data-state')
    const body = await text(page)
    check(`API ${label} renders state "${expect}", not an empty list`, state === expect && !/No bookings match/.test(body) && !/0 results/.test(body), `${state} | ref: ${body.match(/Reference: \S+ \S+ \S+ \S+/)?.[0] ?? ''}`)
    await page.unroute('**/api/v1/admin/operations/bookings*')
  }
  await page.route('**/api/v1/admin/operations/bookings*', r => r.abort())
  await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-state]', { timeout: 15000 })
  check('Network failure renders "unreachable"', (await page.locator('[data-state]').first().getAttribute('data-state')) === 'unreachable')
  await page.unroute('**/api/v1/admin/operations/bookings*')
  await page.route('**/api/v1/admin/operations/bookings*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { items: [], page: 1, pageSize: 25, total: 0 }, meta: {} }) }))
  await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-state=empty]', { timeout: 15000 })
  check('A successful empty response renders the EMPTY state', true)
  await page.unroute('**/api/v1/admin/operations/bookings*')

  // 6. accessibility (axe) on the data pages
  for (const path of ['/bookings', `/bookings/${seed.confirmedBookingId}`, '/audit', '/operations']) {
    await page.goto(`${BASE}${path}`); await page.waitForSelector('table, [data-testid=booking-360], section')
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    const serious = axe.violations.filter(v => ['serious', 'critical'].includes(v.impact))
    check(`axe ${path}: no serious/critical violations`, serious.length === 0, serious.map(v => `${v.id}(${v.nodes.length})`).join(','))
  }
  check('no uncaught page errors', errors.length === 0, errors.join(' | ').slice(0, 200))
  await ctx.close()

  // 7. viewer: lacks booking.read/audit.read — sidebar hides, API returns forbidden state
  const v = await login(browser, seed.viewerEmail)
  await v.page.goto(`${BASE}/bookings`); await v.page.waitForSelector('[data-state]', { timeout: 15000 })
  check('Viewer without booking.read sees FORBIDDEN on /bookings', (await v.page.locator('[data-state]').first().getAttribute('data-state')) === 'forbidden')
  await v.page.goto(`${BASE}/audit`); await v.page.waitForSelector('[data-state]', { timeout: 15000 })
  check('Viewer without audit.read sees FORBIDDEN on /audit', (await v.page.locator('[data-state]').first().getAttribute('data-state')) === 'forbidden')
  const nav = await v.page.locator('nav, aside').first().innerText()
  check('Viewer sidebar hides Bookings/Audit', !/Bookings|Audit explorer|Reconciliation/.test(nav), nav.replace(/\s+/g, ' ').slice(0, 120))
  await v.ctx.close()

  // 8. tenant B owner cannot see tenant A data, and A's booking id is a not-found for B
  const bb = await login(browser, seed.bownerEmail)
  await bb.page.goto(`${BASE}/bookings`); await bb.page.waitForSelector('table')
  check('Tenant B sees only its own booking (1 result)', /1 result/.test(await text(bb.page)))
  await bb.page.goto(`${BASE}/bookings/${seed.confirmedBookingId}`); await bb.page.waitForSelector('[data-state]', { timeout: 15000 })
  check('Tenant B opening tenant A booking id gets not-found', (await bb.page.locator('[data-state]').first().getAttribute('data-state')) === 'not-found')
  await bb.page.goto(`${BASE}/connectors`); await bb.page.waitForSelector('.admin-empty, table')
  check('Tenant B sees no connectors', /No connectors configured/.test(await text(bb.page)))
  await bb.ctx.close()

  await browser.close()
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
