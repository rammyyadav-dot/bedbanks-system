// Real-stack browser verification of the unified hotel readiness panel (Distribution & Readiness tab). See README.md. Not run in CI.
// Run against an API that connects as the non-owner runtime role, with the production Admin build, after seed-hotels.ts.
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
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 200) : ''}`) }
const text = async (page) => (await page.locator('main, .admin-page').first().innerText()).replace(/\s+/g, ' ')
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

async function login(browser, email, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport } : {}); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
const form = (page) => page.getByRole('form', { name: 'Readiness criteria' })
async function open(page, key, tab = 'sellability') {
  await page.goto(`${BASE}/hotels/${H[key]}?tab=${tab}`)
  await page.waitForSelector('[data-testid=readiness], [data-state]', { timeout: 20000 })
}
async function assess(page, fill = async () => {}) {
  await fill(); await form(page).getByRole('button', { name: 'Assess readiness' }).click()
  await page.waitForSelector('[data-testid=readiness-result], [role=alert]:not(#__next-route-announcer__)', { timeout: 20000 })
}
const gate = (page, id) => page.locator(`[data-gate=${id}]`)
const outcome = async (page, id) => gate(page, id).getAttribute('data-outcome')

;(async () => {
  const browser = await chromium.launch()
  const { ctx, page } = await login(browser, seed.ownerEmail)
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))

  // ---- shape: seven gates, scope statement, honest evidence gate ------------------------------------------------------------
  await open(page, 'alpha'); await assess(page)
  const ids = await page.locator('[aria-label="Readiness gates"] > li').evaluateAll((els) => els.map((e) => e.getAttribute('data-gate')))
  check('seven separate gates are shown in order', JSON.stringify(ids) === JSON.stringify(['CONTENT', 'MAPPING', 'CONTRACT', 'RATE', 'INVENTORY', 'DISTRIBUTION', 'SEARCH_RECHECK_EVIDENCE']), ids.join(','))
  check('the READY hotel passes mapping, contract, rate and inventory for the stated stay', (await Promise.all(['MAPPING', 'CONTRACT', 'RATE', 'INVENTORY'].map((g) => outcome(page, g)))).every((o) => o === 'PASS'))
  check('search/recheck evidence is UNKNOWN and says a prediction is not evidence', (await outcome(page, 'SEARCH_RECHECK_EVIDENCE')) === 'UNKNOWN' && /not evidence/.test(await page.getByTestId('reason-SEARCH_RECHECK_EVIDENCE').innerText()))
  const body = await text(page)
  check('the verdict states its scope and limits (no universal availability claim)', /apply to the stated stay, occupancy, nationality, agency and currency/.test(body) && /does not imply availability on other dates/.test(body))
  check('predicted offers are labelled as the evaluator prediction', /Evaluator-predicted offers: \d/.test(body))
  check('every gate shows its evaluation time and the criteria it applied', (await page.locator('[data-gate] summary', { hasText: 'Criteria this gate applied' }).count()) === 7 && (await page.locator('[data-gate]').first().innerText()).includes('evaluated'))
  await page.screenshot({ path: `${SHOTS}/readiness-alpha.png`, fullPage: true })

  // ---- blockers are named by their own gate, with a permitted navigation action ------------------------------------------------
  await open(page, 'charlie'); await assess(page)
  check('unapproved mapping fails the MAPPING gate with the canonical reason', (await outcome(page, 'MAPPING')) === 'FAIL' && /SUPPLIER_MAPPING_INVALID/.test(await gate(page, 'MAPPING').innerText()))
  await gate(page, 'MAPPING').getByRole('link', { name: 'Review supplier mappings' }).click(); await page.waitForURL(/tab=mappings/)
  check('the MAPPING action opens the existing Supplier Mapping tab (no second editor)', /tab=mappings/.test(page.url()))
  await open(page, 'foxtrot'); await assess(page)
  check('a missing rate fails RATE as unknown price, not zero, and does not fail INVENTORY', (await outcome(page, 'RATE')) === 'FAIL' && /DAILY_RATE_MISSING_OR_INVALID/.test(await gate(page, 'RATE').innerText()) && (await outcome(page, 'INVENTORY')) === 'PASS' && !/AED 0\.00/.test(await text(page)))
  await open(page, 'golf'); await assess(page)
  check('missing availability fails INVENTORY with AVAILABILITY_MISSING, never zero stock', (await outcome(page, 'INVENTORY')) === 'FAIL' && /AVAILABILITY_MISSING/.test(await gate(page, 'INVENTORY').innerText()))
  await open(page, 'kilo'); await assess(page)
  check('a brand-new hotel fails CONTRACT (no rate plan) and marks RATE and INVENTORY not applicable with a reason', (await outcome(page, 'CONTRACT')) === 'FAIL' && (await outcome(page, 'RATE')) === 'NOT_APPLICABLE' && (await outcome(page, 'INVENTORY')) === 'NOT_APPLICABLE' && /No rate plan exists/.test(await gate(page, 'RATE').innerText()))
  check('content readiness is separate: a DRAFT hotel fails DISTRIBUTION (not published) independently of CONTENT', (await outcome(page, 'DISTRIBUTION')) === 'FAIL' && /HOTEL_INACTIVE/.test(await gate(page, 'DISTRIBUTION').innerText()))

  // ---- criteria: child ages are required, buyer and agency are echoed, invalid input is explained -------------------------------
  await open(page, 'alpha')
  await form(page).getByLabel('Children per room').fill('2')
  check('one age field appears per child and each is required', (await form(page).getByLabel(/Child \d age/).count()) === 2)
  await form(page).getByLabel('Child 1 age').fill('4'); await form(page).getByLabel('Child 2 age').fill('7')
  await form(page).getByLabel('Guest nationality (ISO code)').fill('IN')
  await assess(page)
  const echo = await page.locator('[data-testid=readiness-result] [role=status]').innerText()
  check('the result echoes the party and the nationality that were evaluated', /2 adults \+ 2 children/.test(echo) && /nationality IN/.test(echo), echo)
  check('child-age handling is disclosed as a limitation, not silently ignored', /Child ages are recorded/.test(await text(page)))
  await open(page, 'alpha')
  await form(page).getByLabel('Arrival date').fill(day(-3)); await form(page).getByLabel('Departure date').fill(day(-1))
  await form(page).getByRole('button', { name: 'Assess readiness' }).click(); await page.waitForSelector('[role=alert]:not(#__next-route-announcer__)')
  check('invalid criteria show the API validation message, not a verdict', /Check the criteria/.test(await text(page)) && (await page.locator('[data-testid=readiness-result]').count()) === 0)

  // ---- states: unavailable / denied are explicit, never an empty or passing verdict ---------------------------------------------
  for (const [status, code, label] of [[503, 'OPERATIONS_READ_DENIED', 'denied'], [500, 'INTERNAL', 'server']]) {
    await open(page, 'alpha')
    await page.route('**/readiness?*', (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code, message: 'x' } }) }))
    await assess(page)
    check(`a ${status} response is an explicit failure state with no verdict and no gates (${label})`, (await page.locator('[role=alert]:not(#__next-route-announcer__)').count()) >= 1 && (await page.locator('[data-gate]').count()) === 0)
    await page.unroute('**/readiness?*')
  }
  await open(page, 'alpha'); await page.route('**/readiness?*', (r) => r.abort('failed'))
  await assess(page); check('a network failure is an explicit failure state', (await page.locator('[role=alert]:not(#__next-route-announcer__)').count()) >= 1 && (await page.locator('[data-gate]').count()) === 0); await page.unroute('**/readiness?*')

  // ---- double submit sends one request; keyboard operation ---------------------------------------------------------------------
  await open(page, 'alpha'); let calls = 0; page.on('request', (r) => { if (/\/readiness\?/.test(r.url())) calls++ })
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Assess readiness/.test(x.textContent)); b.click(); b.click() })
  await page.waitForSelector('[data-testid=readiness-result]'); check('a double click sends one readiness request', calls === 1, `requests=${calls}`)
  await open(page, 'alpha'); await form(page).getByLabel('Rooms').focus(); await page.keyboard.press('Enter'); await page.waitForSelector('[data-testid=readiness-result]')
  check('the form submits from the keyboard (Enter in a field)', true)
  const focusable = await page.evaluate(() => { const f = document.querySelector('form[aria-label="Readiness criteria"]'); return [...f.querySelectorAll('input,button')].every((e) => e.tabIndex >= 0) })
  check('every criteria control is keyboard reachable and labelled', focusable && (await form(page).locator('input').evaluateAll((els) => els.every((e) => e.labels && e.labels.length > 0))))

  // ---- layout and accessibility ---------------------------------------------------------------------------------------------------
  for (const [w, h] of [[1280, 900], [768, 900], [390, 844]]) {
    const vp = await login(browser, seed.ownerEmail, { width: w, height: h })
    await open(vp.page, 'charlie'); await assess(vp.page)
    const overflow = await vp.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    check(`no horizontal page overflow at ${w}px with a readiness result`, overflow <= 0, `overflow=${overflow}`)
    await vp.page.screenshot({ path: `${SHOTS}/readiness-${w}.png`, fullPage: true })
    if (w === 1280) {
      const axe = await new AxeBuilder({ page: vp.page }).withTags(['wcag2a', 'wcag2aa']).analyze()
      const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
      check('axe WCAG A/AA: no serious or critical violations on the readiness panel', bad.length === 0, bad.map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0].target.join(' ').slice(0, 80)}`).join(' | '))
    }
    await vp.ctx.close()
  }
  check('no uncaught page errors', errors.length === 0, errors.join(' | '))
  await ctx.close()

  // ---- permissions and tenants -------------------------------------------------------------------------------------------------
  const v = await login(browser, seed.viewerEmail)
  await open(v.page, 'alpha', 'sellability').catch(() => {}); await v.page.waitForSelector('[data-state]', { timeout: 15000 })
  check('a viewer holding only supply.hotels.read is FORBIDDEN from the readiness tab, with no verdict', (await v.page.locator('[data-state=forbidden]').count()) === 1 && (await v.page.locator('[data-gate]').count()) === 0)
  await v.ctx.close()
  const b = await login(browser, seed.bownerEmail)
  await b.page.goto(`${BASE}/hotels/${H.alpha}?tab=sellability`); await b.page.waitForSelector('[data-state]', { timeout: 15000 })
  check("tenant B cannot assess tenant A's hotel (not found, no gates)", (await b.page.locator('[data-state=not-found]').count()) === 1 && (await b.page.locator('[data-gate]').count()) === 0)
  await b.ctx.close()

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
