// Real-stack browser verification of the Admin rate certification workspace (ADR 0033). See README.md. Not run in CI.
const path = require('path')
const fs = require('fs')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const AxeBuilder = req('@axe-core/playwright').default || req('@axe-core/playwright')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-rate-certification.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const SHOTS = process.env.SHOT_DIR ?? require('os').tmpdir()
const H = seed.hotels
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 200) : ''}`) }
const text = async (page) => (await page.locator('main, .admin-page').first().innerText()).replace(/\s+/g, ' ')
const stateOf = async (page) => page.locator('[data-state]').first().getAttribute('data-state')

async function login(browser, email, viewport) {
  const ctx = await browser.newContext({ acceptDownloads: true, ...(viewport ? { viewport } : {}) }); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
const sel = (page, name) => page.locator('label', { has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) }).locator('select')
const tab = async (page, name) => { await page.getByRole('tab', { name }).click(); await page.waitForTimeout(300) }

;(async () => {
  const browser = await chromium.launch()
  const { ctx, page } = await login(browser, seed.ownerEmail)
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  const writes = []
  page.on('request', (r) => { if (r.url().includes('/api/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${new URL(r.url()).pathname}`) })

  // ---- summary --------------------------------------------------------------------------------------------------------------
  await page.goto(`${BASE}/rate-certification`); await page.waitForSelector('[data-testid=summary]', { timeout: 30000 })
  const nav = await page.locator('nav').first().innerText()
  check('sidebar lists Rate Certification', /Rate Certification/.test(nav))
  const plans = (await page.locator('[data-testid=plans-counts]').innerText()).replace(/\s+/g, ' ')
  const hotels = (await page.locator('[data-testid=hotels-counts]').innerText()).replace(/\s+/g, ' ')
  check('plan counts are exact: 3 PASS, 3 WARN, 6 FAIL', plans === '3 PASS · 3 WARN · 6 FAIL', plans)
  check('hotel counts are exact: 3 certified, 3 with warnings, 6 not ready', hotels === '3 certified · 3 with warnings · 6 not ready', hotels)
  const rows = (await page.locator('[data-testid=row-classes]').first().innerText()).replace(/\s+/g, ' ')
  check('row classes are exact (848 valid, 183 quarantined, 7 dead, 0 outside, 90 blocked)', /VALID 848/.test(rows) && /QUARANTINED 183/.test(rows) && /DEAD 7/.test(rows) && /OUTSIDE CONTRACT 0/.test(rows) && /BLOCKED NO MARKUP 90/.test(rows), rows)
  check('summary says it is read-only and not a switch', /READ ONLY/.test(await text(page)) && /does not change what Agents can search or book/.test(await text(page)))
  await page.screenshot({ path: `${SHOTS}/rate-certification-summary.png`, fullPage: true })

  // ---- hotels tab -------------------------------------------------------------------------------------------------------------
  await page.waitForSelector('[data-testid=hotels-table]')
  const statusOf = async (name) => (await page.locator('[data-testid=hotels-table] tbody tr', { hasText: name }).first().getAttribute('data-status'))
  check('Aurora Grand is CERTIFIED', (await statusOf('Aurora Grand')) === 'CERTIFIED')
  check('Lagoon NET Priced is CERTIFIED (NET rates with an ACTIVE hotel markup rule)', (await statusOf('Lagoon NET')) === 'CERTIFIED')
  check('Dune Gap is READY_WITH_WARNINGS', (await statusOf('Dune Gap')) === 'READY_WITH_WARNINGS')
  for (const name of ['Bay Zero', 'Creek NET', 'Emerald Inactive', 'Falcon Duplicate', 'Gulf Unverified', 'Harbour USD']) check(`${name} is NOT_READY`, (await statusOf(name)) === 'NOT_READY')
  await sel(page, 'Distribution status').selectOption('NOT_READY'); await page.waitForTimeout(600)
  check('status filter shows exactly the 6 not-ready hotels', (await page.locator('[data-testid=hotels-table] tbody tr').count()) === 6)
  check('Emerald Inactive is blocked for having no live rate plan', /No live rate plan/.test(await page.locator('[data-testid=hotels-table] tbody tr', { hasText: 'Emerald Inactive' }).innerText()))

  // ---- plans tab ---------------------------------------------------------------------------------------------------------------
  await tab(page, 'Rate plans'); await page.waitForSelector('[data-testid=plans-table]')
  check('all 13 plans are listed', /13 results/.test(await page.locator('[data-testid=pager]').innerText()))
  await sel(page, 'Certification').selectOption('FAIL'); await page.waitForTimeout(600)
  check('FAIL filter shows exactly 6 plans', (await page.locator('[data-testid=plans-table] tbody tr').count()) === 6)
  await sel(page, 'Certification').selectOption(''); await page.waitForTimeout(800); await sel(page, 'Plan state').selectOption('false'); await page.waitForFunction(() => /^1 result /.test(document.querySelector('[data-testid=pager]')?.textContent ?? ''), null, { timeout: 15000 })
  check('"Not live" filter shows only the inactive plan, labelled NOT LIVE', (await page.locator('[data-testid=plans-table] tbody tr').count()) === 1 && /NOT LIVE/.test(await text(page)))
  await sel(page, 'Plan state').selectOption(''); await sel(page, 'Finding').selectOption('DUPLICATE_LOGICAL_PLAN'); await page.waitForFunction(() => /^2 results /.test(document.querySelector('[data-testid=pager]')?.textContent ?? ''), null, { timeout: 15000 })
  check('finding filter DUPLICATE_LOGICAL_PLAN shows both duplicate plans', (await page.locator('[data-testid=plans-table] tbody tr').count()) === 2)
  await page.screenshot({ path: `${SHOTS}/rate-certification-plans.png`, fullPage: true })

  // ---- plan detail -------------------------------------------------------------------------------------------------------------
  await page.goto(`${BASE}/rate-certification/${H.bravo.planId}`); await page.waitForSelector('[data-testid=plan-audit]', { timeout: 20000 })
  const detail = await text(page)
  check('zero-amount plan: FAIL with RATE_AMOUNT_ZERO and 3 affected nights', (await page.locator('[data-testid=plan-audit]').getAttribute('data-status')) === 'FAIL' && /RATE_AMOUNT_ZERO/.test(detail) && /\(3\)/.test(detail))
  check('zero-amount plan: 3 quarantined and 87 valid rows', /QUARANTINED\s*3/.test(detail) && /VALID\s*87/.test(detail))
  check('calendar lists all 90 nights with the zero rows quarantined', (await page.locator('[data-testid=calendar] tbody tr').count()) === 90 && (await page.locator('[data-testid=calendar] tbody tr', { hasText: 'QUARANTINED' }).count()) === 3)
  await page.screenshot({ path: `${SHOTS}/rate-certification-detail.png`, fullPage: true })
  await page.goto(`${BASE}/rate-certification/${H.juliet.planId}`); await page.waitForSelector('[data-testid=plan-audit]')
  check('bad code format: WARN with a suggestion that is not applied', (await page.locator('[data-testid=plan-audit]').getAttribute('data-status')) === 'WARN' && /JADE-STANDARD/.test(await page.locator('[data-testid=suggested-code]').innerText()) && /nothing is renamed automatically/.test(await text(page)))
  await page.goto(`${BASE}/rate-certification/${H.india.planId}`); await page.waitForSelector('[data-testid=plan-audit]')
  check('recorded markets: INFO that search enforces them, plan stays PASS', (await page.locator('[data-testid=plan-audit]').getAttribute('data-status')) === 'PASS' && /CONTRACT_MARKET_RESTRICTED/.test(await text(page)) && /Agent search enforces this/.test(await text(page)))
  await page.goto(`${BASE}/rate-certification/${H.alpha.planId}`); await page.waitForSelector('[data-testid=plan-audit]')
  check('clean plan: PASS with no findings', (await page.locator('[data-testid=plan-audit]').getAttribute('data-status')) === 'PASS' && (await page.locator('[data-testid=no-findings]').count()) === 1)

  // ---- remediation, markup rules -------------------------------------------------------------------------------------------------
  await page.goto(`${BASE}/rate-certification?tab=remediation`); await page.waitForSelector('[data-testid=remediation-table]')
  const prio = await page.locator('[data-testid=remediation-table] tbody tr').evaluateAll((els) => els.map((e) => e.getAttribute('data-priority')))
  check('remediation queue is ordered P0 then P1 then P2', prio.length > 0 && JSON.stringify(prio) === JSON.stringify([...prio].sort()) && prio[0] === 'P0', prio.join(','))
  const rc = await page.locator('[data-testid=remediation-counts]').innerText()
  check('remediation counts are shown and nothing is executable', /P0/.test(rc) && (await page.locator('[data-testid=remediation-table] tbody button').count()) === 0 && /Nothing here can be executed/.test(await text(page)), rc)
  await sel(page, 'Priority').selectOption('P0'); await page.waitForTimeout(600)
  const p0codes = await page.locator('[data-testid=remediation-table] tbody tr').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-code')))].sort())
  check('P0 holds the price-integrity findings', ['NET_MARKUP_MISSING', 'RATE_AMOUNT_ZERO', 'RATE_BASIS_UNVERIFIED', 'RATE_CURRENCY_MISMATCH'].every((c) => p0codes.includes(c)), p0codes.join(','))
  await page.goto(`${BASE}/rate-certification?tab=markup`); await page.waitForSelector('[data-testid=markup-table]')
  check('markup audit lists the one ACTIVE rule and says rules are authored elsewhere', (await page.locator('[data-testid=markup-table] tbody tr').count()) === 1 && /1 active/.test(await text(page)) && /Rules are authored under/.test(await text(page)))

  // ---- simulator ---------------------------------------------------------------------------------------------------------------
  const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  const simulate = async (planId, extra = {}) => {
    await page.goto(`${BASE}/rate-certification?tab=simulator&ratePlanId=${planId}`); await page.waitForSelector('[data-testid=simulator]')
    await page.locator('form[aria-label="Price simulator"] input[type=date]').nth(0).fill(day(10)); await page.locator('form[aria-label="Price simulator"] input[type=date]').nth(1).fill(day(13))
    if (extra.rooms) await page.locator('form[aria-label="Price simulator"] input[type=number]').nth(2).fill(String(extra.rooms))
    await page.getByRole('button', { name: 'Simulate' }).click(); await page.waitForSelector('[data-testid=simulation-result]', { timeout: 20000 })
    return { total: await page.locator('[data-testid=simulation-total]').innerText().catch(() => null), eligible: await page.locator('[data-testid=simulation-result]').getAttribute('data-eligible'), body: await text(page) }
  }
  const sell = await simulate(H.alpha.planId)
  check('SELL stay: sellable, 3 nights of AED 499.00 = AED 1,497.00, reconciles', sell.eligible === 'true' && /1,497\.00/.test(sell.total) && /RECONCILES/.test(sell.body), sell.total)
  const two = await simulate(H.alpha.planId, { rooms: 2 })
  check('two rooms double the total (AED 2,994.00)', /2,994\.00/.test(two.total), two.total)
  const net = await simulate(H.lima.planId)
  check('NET stay with a markup rule: 10% half-up per night, 3 nights = AED 1,646.70, reconciles', net.eligible === 'true' && /1,646\.70/.test(net.total) && /10\.00%/.test(net.body) && /RECONCILES/.test(net.body), net.total)
  const refused = await simulate(H.charlie.planId)
  check('NET stay without a markup rule is REFUSED with the evaluator reason and no price', refused.eligible === 'false' && /NET_RATE_MARKUP_UNAVAILABLE/.test(refused.body) && refused.total === null)
  const before = writes.filter((w) => w.includes('/simulate')).length
  await page.getByRole('button', { name: 'Simulate' }).dblclick(); await page.waitForTimeout(1200)
  check('a double click sends at most one simulate request', writes.filter((w) => w.includes('/simulate')).length - before <= 1, `${writes.filter((w) => w.includes('/simulate')).length - before}`)
  await page.screenshot({ path: `${SHOTS}/rate-certification-simulator.png`, fullPage: true })

  // ---- report ---------------------------------------------------------------------------------------------------------------------
  await page.goto(`${BASE}/rate-certification?tab=report`); await page.waitForSelector('[data-testid=report-tab]')
  const [md] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.getByRole('button', { name: 'Download Markdown' }).click()])
  const mdPath = await md.path(); const mdText = fs.readFileSync(mdPath, 'utf8')
  check('Markdown report downloads with the exact counts and the not-applicable section', /rate-certification-\d{4}-\d{2}-\d{2}\.md/.test(md.suggestedFilename()) && /Plans PASS \/ WARN \/ FAIL \| 3 \/ 3 \/ 6/.test(mdText) && /\| VALID \| 848 \|/.test(mdText) && /Not applicable to fBeds/.test(mdText))
  const [js] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.getByRole('button', { name: 'Download JSON' }).click()])
  const parsed = JSON.parse(fs.readFileSync(await js.path(), 'utf8'))
  check('JSON report parses and matches', parsed.plans.length === 13 && parsed.hotels.length === 12 && parsed.summary.plans.FAIL === 6)
  check('the report contains no secrets', !/password|token|secret|credential/i.test(mdText + JSON.stringify(parsed)))
  check('the not-applicable list is shown on the page', (await page.locator('[data-testid=not-applicable] li').count()) >= 6)

  // ---- failure states ----------------------------------------------------------------------------------------------------------------
  for (const [status, code, expect] of [[403, 'FORBIDDEN', 'forbidden'], [503, 'COMMERCIAL_CONTROL_UNAVAILABLE', 'not-configured'], [500, 'INTERNAL_SERVER_ERROR', 'error']]) {
    await page.route('**/api/v1/admin/rate-certification/summary*', (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code, message: 'x', details: [] }, meta: { requestId: 'req-rc-1' } }) }))
    await page.goto(`${BASE}/rate-certification?tab=markup`); await page.waitForSelector('[data-state]', { timeout: 15000 })
    const body = await text(page)
    check(`summary API ${status} renders an explicit "${expect}" state, never zero counts`, (await stateOf(page)) === expect && !/0 PASS/.test(body), await stateOf(page))
    await page.unroute('**/api/v1/admin/rate-certification/summary*')
  }
  await page.route('**/api/v1/admin/rate-certification/summary*', (r) => r.abort()); await page.goto(`${BASE}/rate-certification`); await page.waitForSelector('[data-state]', { timeout: 15000 })
  check('network failure renders "unreachable"', (await stateOf(page)) === 'unreachable'); await page.unroute('**/api/v1/admin/rate-certification/summary*')
  await page.route('**/api/v1/admin/rate-certification/simulate', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'COMMERCIAL_CONTROL_UNAVAILABLE', message: 'x', details: [] }, meta: {} }) }))
  await page.goto(`${BASE}/rate-certification?tab=simulator&ratePlanId=${H.alpha.planId}`); await page.waitForSelector('[data-testid=simulator]')
  await page.locator('form[aria-label="Price simulator"] input[type=date]').nth(0).fill(day(10)); await page.locator('form[aria-label="Price simulator"] input[type=date]').nth(1).fill(day(12)); await page.getByRole('button', { name: 'Simulate' }).click(); await page.waitForSelector('[role=alert]:not(#__next-route-announcer__)')
  check('a failed simulation shows an error and no price', (await page.locator('[data-testid=simulation-result]').count()) === 0)
  await page.unroute('**/api/v1/admin/rate-certification/simulate')

  // ---- read-only ----------------------------------------------------------------------------------------------------------------------
  check('the only non-GET API calls in the whole session were simulator POSTs', writes.length > 0 && writes.every((w) => w === 'POST /api/v1/admin/rate-certification/simulate'), [...new Set(writes)].join(','))

  // ---- layout and accessibility ----------------------------------------------------------------------------------------------------
  for (const w of [1280, 768, 390]) {
    const { ctx: c2, page: p2 } = await login(browser, seed.ownerEmail, { width: w, height: 900 })
    for (const url of [`${BASE}/rate-certification`, `${BASE}/rate-certification?tab=plans`, `${BASE}/rate-certification?tab=simulator`, `${BASE}/rate-certification/${H.bravo.planId}`]) {
      await p2.goto(url); await p2.waitForSelector('[data-testid=hotels-table], [data-testid=plans-table], [data-testid=simulator], [data-testid=plan-audit], [data-state]', { timeout: 20000 }); await p2.waitForTimeout(500)
      const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      check(`no page-level horizontal overflow at ${w}px on ${new URL(url).pathname}${new URL(url).search}`, overflow <= 1, `overflow=${overflow}`)
    }
    await c2.close()
  }
  for (const [label, url, sel] of [['Summary and hotels', `${BASE}/rate-certification`, '[data-testid=hotels-table]'], ['Rate plans', `${BASE}/rate-certification?tab=plans`, '[data-testid=plans-table]'], ['Remediation', `${BASE}/rate-certification?tab=remediation`, '[data-testid=remediation-table]'], ['Markup rules', `${BASE}/rate-certification?tab=markup`, '[data-testid=markup-table]'], ['Simulator', `${BASE}/rate-certification?tab=simulator`, '[data-testid=simulator]'], ['Report', `${BASE}/rate-certification?tab=report`, '[data-testid=report-tab]'], ['Plan detail', `${BASE}/rate-certification/${H.bravo.planId}`, '[data-testid=plan-audit]']]) {
    await page.goto(url); await page.waitForSelector(sel, { timeout: 20000 }); await page.waitForTimeout(400)
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
    check(`axe ${label}: no serious/critical violations`, bad.length === 0, bad.map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0].target.join(' ').slice(0, 60)}`).join(' | '))
  }
  check('no uncaught page errors', errors.length === 0, errors.join('; '))
  await ctx.close()

  // ---- permissions and tenants --------------------------------------------------------------------------------------------------------
  const viewer = await login(browser, seed.viewerEmail)
  await viewer.page.goto(`${BASE}/dashboard`); await viewer.page.waitForTimeout(800)
  check('viewer (supply.hotels.read only): no Rate Certification navigation', !/Rate Certification/.test(await viewer.page.locator('nav').first().innerText()))
  await viewer.page.goto(`${BASE}/rate-certification`); await viewer.page.waitForSelector('[data-state]', { timeout: 20000 })
  check('viewer deep-linking gets FORBIDDEN, not an empty page', (await stateOf(viewer.page)) === 'forbidden')
  await viewer.ctx.close()
  const b = await login(browser, seed.bownerEmail)
  await b.page.goto(`${BASE}/rate-certification`); await b.page.waitForSelector('[data-testid=summary]', { timeout: 30000 })
  check('tenant B sees only its own plan and hotel', /1 live of 1/.test(await text(b.page)) && /1 assessed/.test(await text(b.page)))
  await b.page.goto(`${BASE}/rate-certification/${H.alpha.planId}`); await b.page.waitForSelector('[data-state]', { timeout: 20000 })
  check("tenant B opening tenant A's plan gets not-found", (await stateOf(b.page)) === 'not-found')
  await b.ctx.close()

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) { console.log('FAILED:\n' + failed.map((f) => ' - ' + f.name).join('\n')); process.exit(1) }
})().catch((e) => { console.error(e); process.exit(1) })
