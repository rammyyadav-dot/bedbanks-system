// Real-stack browser verification of the Admin booking list and detail (ADR 0039, Phase 1): production Admin build, API on the STRICT runtime role
// (no booking grants) with the booking module on its own SELECT-only role. Needs OWNER_DATABASE_URL to briefly disable that role for the 503 check. Not run in CI.
const path = require('path')
const { execFileSync } = require('child_process')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const AxeBuilder = req('@axe-core/playwright').default || req('@axe-core/playwright')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-bookings.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const OWNER = process.env.OWNER_DATABASE_URL
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 160) : ''}`) }
async function login(browser, email) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
const rows = (page) => page.locator('[data-testid=bookings-table] tbody tr').count()

;(async () => {
  const browser = await chromium.launch()
  // ---- operator without pii/net ----
  let { page, ctx } = await login(browser, seed.opsEmail)
  const mutating = []; page.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method()) && !r.url().includes('/auth/')) mutating.push(r.method() + ' ' + r.url()) })
  await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-testid=bookings-table], [data-testid=booking-empty]', { timeout: 20000 })
  check('opens on the Needs action chip', await page.getByRole('button', { name: /needs action/i }).first().getAttribute('aria-pressed') === 'true')
  const count1 = await rows(page); check('list shows API rows', count1 > 0, count1)
  const text = await page.locator('[data-testid=bookings-table]').innerText()
  check('guest names are masked without booking.pii.view', /•/.test(text) && !/Amira|Haddad|Oliver|Grant/.test(text))
  check('net rate / margin are not shown without booking.view.net', !/margin|net rate/i.test(await page.locator('[data-testid=bookings-table] thead').innerText()))
  await page.getByRole('button', { name: /^latest bookings$/i }).first().click(); await page.waitForTimeout(800)
  check('filter state lives in the URL', /chip=/.test(page.url()), page.url())
  await page.goto(`${BASE}/bookings?chip=latest&status=CONFIRMED,FAILED`); await page.waitForSelector('[data-testid=bookings-table], [data-testid=booking-empty]')
  const statusTxt = await page.locator('[data-testid=bookings-table] tbody').innerText()
  check('status multi-filter applies', (await rows(page)) > 0 && !/Cancelled|Rejected|No show/i.test(statusTxt))
  await page.goto(`${BASE}/bookings?chip=latest&status=REJECTED&supplier=Nope`); await page.waitForSelector('[data-testid=booking-empty]')
  check('empty result explains itself', /no booking|match/i.test(await page.getByTestId('booking-empty').innerText()))
  await page.goto(`${BASE}/bookings?chip=latest`); await page.waitForSelector('[data-testid=bookings-table]')
  const link = page.locator('[data-testid=bookings-table] a[aria-label^="View booking"]').first(); const href = await link.getAttribute('href'); await link.click()
  await page.waitForSelector('[data-testid=booking-header]', { timeout: 20000 })
  check('detail opens from the list', new RegExp(href).test(page.url()))
  for (const [tab, sel] of [['Pricing', '[data-testid=pricing]'], ['Timeline', '[data-testid=timeline]']]) { await page.getByRole('tab', { name: tab }).click(); await page.waitForSelector(sel, { timeout: 15000 }); check(`detail tab ${tab} renders`, true) }
  await page.getByRole('tab', { name: 'Pricing' }).click(); await page.waitForSelector('[data-testid=pricing]')
  check('pricing hides net without booking.view.net', !/net rate/i.test(await page.getByTestId('pricing').innerText()) || /not available|hidden|permission/i.test(await page.getByTestId('pricing').innerText()))
  await page.getByRole('tab', { name: 'Operations record' }).click(); await page.waitForTimeout(1200)
  check('operations record is labelled unavailable, not empty, on the strict role', /unavailable|not readable|cannot be read/i.test(await page.locator('#booking-panel').innerText()), (await page.locator('#booking-panel').innerText()).slice(0, 80))
  await page.goto(`${BASE}/bookings/does-not-exist`); await page.waitForTimeout(1500)
  check('unknown booking shows a not-found state', /not found|no such|can.t find/i.test(await page.locator('main, body').first().innerText()))
  await page.goto(`${BASE}/bookings?chip=latest`); await page.waitForSelector('[data-testid=bookings-table]')
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze(); const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
  check('axe WCAG A/AA clean on the list', bad.length === 0, bad.map((v) => v.id + ':' + v.nodes.length).join(','))
  await page.setViewportSize({ width: 390, height: 800 }); await page.goto(`${BASE}/bookings?chip=latest`); await page.waitForSelector('[data-testid=bookings-table]')
  check('no horizontal page scroll at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  check('reading made no non-GET request', mutating.length === 0, mutating.join(' | '))
  await ctx.close()

  // ---- operator with pii + net ----
  ;({ page, ctx } = await login(browser, seed.opsAllEmail))
  await page.goto(`${BASE}/bookings?chip=latest`); await page.waitForSelector('[data-testid=bookings-table]')
  check('unmasked guest names with booking.pii.view', /Amira|Oliver|Sofia|Khalid|Emma|Lucas/.test(await page.locator('[data-testid=bookings-table]').innerText()))
  await ctx.close()

  // ---- agency user ----
  ;({ page, ctx } = await login(browser, seed.agencyEmail))
  await page.goto(`${BASE}/bookings?chip=latest&pageSize=100`); await page.waitForSelector('[data-testid=bookings-table]', { timeout: 20000 })
  const agencyText = await page.locator('[data-testid=bookings-table]').innerText()
  check('agency user sees only their agency', /Travel Republic/.test(agencyText) && !/Atlas Getaways|Global Holidays|Enterprise Travel Group/.test(agencyText))
  await ctx.close()

  // ---- missing role: real 503 ----
  if (OWNER) {
    execFileSync('psql', [OWNER, '-qc', 'ALTER ROLE fbeds_booking_ops NOLOGIN', '-c', "select pg_terminate_backend(pid) from pg_stat_activity where usename='fbeds_booking_ops'"])
    try {
      ;({ page, ctx } = await login(browser, seed.opsEmail))
      await page.goto(`${BASE}/bookings?chip=latest`); await page.waitForTimeout(2500)
      const t = await page.locator('main').innerText()
      check('role unavailable shows the not-readable state, no rows, no fallback', /OPERATIONS_READ_DENIED/.test(t) && /not an empty result/i.test(t) && (await page.locator('[data-testid=bookings-table] tbody tr').count()) === 0, t.slice(0, 100))
      await ctx.close()
    } finally { execFileSync('psql', [OWNER, '-qc', 'ALTER ROLE fbeds_booking_ops LOGIN']) }
  }
  await browser.close()
  const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} passed`); process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
