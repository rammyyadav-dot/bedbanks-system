// Real-stack browser verification of Inventory & Allotment (ADR 0030): Admin shapes a shared pool, the Agent sees one shared stock,
// a change in Admin flips the Agent's recheck. See README.md. Not run in CI. Needs the API, Admin (:3000) and Agent (:3003) builds.
const path = require('path')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const AxeBuilder = req('@axe-core/playwright').default || req('@axe-core/playwright')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-inventory.json'))
const ADMIN = process.env.ADMIN_URL ?? 'http://localhost:3000'
const AGENT = process.env.AGENT_URL ?? 'http://localhost:3003'
const SHOTS = process.env.SHOT_DIR ?? require('os').tmpdir()
const H = seed.hotels
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 200) : ''}`) }
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

async function adminLogin(browser, email, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport } : {}); const page = await ctx.newPage()
  await page.goto(`${ADMIN}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
async function openInventory(page, key = 'palm') {
  await page.goto(`${ADMIN}/hotels/${H[key]}?tab=inventory`)
  await page.waitForSelector('[data-testid=inventory-workspace] [data-testid=inventory-totals], [data-testid=inventory-workspace] [data-state]', { timeout: 20000 })
}
async function quickUpdate(page, { allotment, mode, reason }) {
  await page.goto(`${ADMIN}/hotels/${H.palm}?tab=quick`); await page.waitForSelector('[data-testid=quick-update] table[aria-label="Rate plans to update"]', { timeout: 20000 })
  for (const code of ['P1', 'P2', 'P3']) await page.getByLabel(`Select ${code}`).check()
  const dates = page.locator('fieldset:has(legend:has-text("Dates")) input[type=date]')
  await dates.nth(0).fill(day(10)); await dates.nth(1).fill(day(11))
  await page.getByLabel('Change availability').check()
  if (allotment !== undefined) await page.getByLabel(/^Allotment \(units/).fill(String(allotment))
  if (mode) await page.getByLabel('Inventory mode').selectOption(mode)
  await page.getByTestId('qu-preview').click(); await page.waitForSelector('[data-testid=qu-preview-result]', { timeout: 20000 })
  const preview = (await page.getByTestId('qu-preview-result').innerText()).replace(/\s+/g, ' ')
  await page.getByLabel(/^Reason/).fill(reason)
  await page.getByTestId('qu-apply').click(); await page.waitForSelector('[data-testid=qu-result]', { timeout: 20000 })
  return { preview, result: (await page.getByTestId('qu-result').innerText()).replace(/\s+/g, ' ') }
}
async function agentSearch(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage()
  await page.goto(`${AGENT}/login`); await page.fill('#email', seed.agentEmail); await page.fill('#password', seed.password); await page.click('button[type=submit]')
  await page.waitForSelector('#hotel-search', { timeout: 30000 })
  await page.getByLabel('Destination').click(); await page.getByLabel('Destination').fill('Dubai'); await page.getByRole('option', { name: /Dubai/ }).first().click()
  await page.locator('.market-field:has(> span:text-is("Stay")) button.market-control').click()
  await page.getByLabel('Check-in').fill(day(10)); await page.getByLabel('Check-out').fill(day(12))
  await page.getByRole('button', { name: /^Search/ }).first().click()
  await page.waitForSelector('article.market-hotel-card', { timeout: 30000 })
  return { ctx, page }
}

;(async () => {
  const browser = await chromium.launch()
  const { ctx, page } = await adminLogin(browser, seed.ownerEmail, { width: 1280, height: 900 })
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))

  // ---- Hotels -> hotel -> Inventory & Allotment --------------------------------------------------------------------------------
  await page.goto(`${ADMIN}/hotels?search=${encodeURIComponent(seed.names.palm)}`); await page.waitForSelector('[data-testid=hotels-table]', { timeout: 20000 })
  await page.getByRole('link', { name: seed.names.palm }).first().click()
  await page.waitForSelector('[data-testid=hotel-header]', { timeout: 20000 })
  const tab = page.getByRole('tab', { name: 'Inventory & Allotment' })
  check('the hotel has an "Inventory & Allotment" tab', (await tab.count()) === 1)
  await tab.click(); await page.waitForSelector('[data-testid=inventory-totals]', { timeout: 20000 })
  const totals = (await page.getByTestId('inventory-totals').innerText()).replace(/\s+/g, ' ')
  check('summary shows 3 plans, 3 pooled plans and 1 active pool', /Rate plans 3/.test(totals) && /Plans in a shared pool 3/.test(totals) && /Active pools 1/.test(totals), totals)
  const card = page.getByTestId('pool-card')
  check('the shared pool lists its three plans', (await card.count()) === 1 && (await card.locator('[data-member]').count()) === 3)
  const firstRow = card.locator('tbody tr').first()
  const cells = (await firstRow.locator('td').allInnerTexts()).map((t) => t.trim())
  check('pool night shows capacity 5, sold 0, held 0, remaining 5 (one stock, not 15)', cells[1] === '5' && cells[2] === '0' && cells[3] === '0' && cells[4] === '5', cells.join('|'))
  check('plan table shows hotel-local release rule and mode counts', /0 days before check-in at 00:00/.test(await page.getByRole('table', { name: 'Rate plan inventory' }).innerText()))
  await page.screenshot({ path: `${SHOTS}/inventory-workspace.png`, fullPage: true })

  // ---- edit: Quick Update the shared capacity (preview -> apply) ------------------------------------------------------------------
  const first = await quickUpdate(page, { allotment: 1, reason: 'browser acceptance: shared capacity 1' })
  check('preview names the pool capacity change from 5 to 1 and what will change', /poolCapacity: 5 → 1/.test(first.preview) && /will change/.test(first.preview), first.preview.slice(0, 200))
  check('apply reports pool nights written (one per night, not one per plan)', /2 pool nights written/.test(first.result), first.result)

  // ---- reload: persisted ---------------------------------------------------------------------------------------------------------
  await openInventory(page)
  const reloaded = (await page.getByTestId('pool-card').locator(`tr[data-date="${day(10)}"] td`).allInnerTexts()).map((t) => t.trim())
  check('after reload the pool night shows capacity 1 and remaining 1', reloaded[1] === '1' && reloaded[4] === '1', reloaded.join('|'))

  // ---- Agent: search and inspect the offer ---------------------------------------------------------------------------------------
  const agent = await agentSearch(browser); const apage = agent.page
  const hotelCard = apage.locator('article.market-hotel-card').filter({ hasText: seed.names.palm })
  check('Agent search lists the pooled hotel', (await hotelCard.count()) === 1)
  await hotelCard.getByRole('button', { name: /View rooms/ }).click(); await apage.waitForSelector('.market-room-group', { timeout: 15000 })
  const rowsA = apage.locator('.market-rate-row')
  check('all three plans are offered, each flagged "Limited availability" (the pool has one unit left)', (await rowsA.count()) === 3 && (await rowsA.filter({ hasText: 'Limited availability' }).count()) === 3, await rowsA.count())
  await rowsA.first().getByRole('button', { name: 'Select Offer' }).click()
  await apage.waitForSelector('.portal-hold-outcome.is-rechecked', { timeout: 20000 })
  check('recheck of the selected offer is authoritative: rechecked', (await apage.locator('.portal-hold-outcome.is-rechecked').count()) === 1)
  await apage.screenshot({ path: `${SHOTS}/agent-limited-offer.png` })

  // ---- Admin changes inventory (pool capacity to 0), then Agent rechecks the same offer -------------------------------------------
  const second = await quickUpdate(page, { allotment: 0, reason: 'browser acceptance: close the pool' })
  check('Admin set the pool to 0', /2 pool nights written/.test(second.result), second.result)
  await rowsA.first().getByRole('button', { name: 'Select Offer' }).click()
  await apage.waitForSelector('.portal-hold-outcome.is-unavailable', { timeout: 20000 })
  check('the same offer now rechecks as unavailable (no silent substitution)', (await apage.locator('.portal-hold-outcome.is-unavailable').count()) === 1 && (await apage.getByRole('button', { name: 'View alternative rooms' }).count()) === 1)
  await apage.screenshot({ path: `${SHOTS}/agent-unavailable-recheck.png` })
  await apage.getByRole('button', { name: 'Search again' }).click(); await apage.waitForTimeout(3000)
  const stillThere = await apage.locator('article.market-hotel-card').filter({ hasText: seed.names.palm }).count()
  check('a fresh search no longer offers the pooled hotel', stillThere === 0, `cards=${stillThere}`)

  // ---- ON REQUEST is shown but never selectable -------------------------------------------------------------------------------------
  await quickUpdate(page, { allotment: 5, mode: 'ON_REQUEST', reason: 'browser acceptance: on request' })
  const agent2 = await agentSearch(browser); const bpage = agent2.page
  const card2 = bpage.locator('article.market-hotel-card').filter({ hasText: seed.names.palm }); await card2.getByRole('button', { name: /View rooms/ }).click(); await bpage.waitForSelector('.market-rate-row')
  const reqRows = bpage.locator('.market-rate-row')
  check('on-request rates are labelled "On request · not confirmed" and the button is disabled', (await reqRows.filter({ hasText: 'On request · not confirmed' }).count()) === 3 && (await reqRows.first().getByRole('button', { name: 'On request' }).isDisabled()))
  await bpage.screenshot({ path: `${SHOTS}/agent-on-request.png` })
  await agent.ctx.close(); await agent2.ctx.close()

  // ---- states: loading, empty, unavailable, forbidden -----------------------------------------------------------------------------
  await openInventory(page, 'solo')
  check('a hotel with no pool shows the empty pool state, not zero stock', (await page.getByTestId('no-pools').count()) === 1)
  await page.route('**/api/v1/admin/hotels/*/inventory/summary*', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'unavailable' } }) }))
  await page.goto(`${ADMIN}/hotels/${H.palm}?tab=inventory`); await page.waitForSelector('[data-testid=inventory-workspace] [data-state]', { timeout: 20000 })
  check('an API failure is shown as an explicit unavailable state, never as zero inventory', (await page.locator('[data-testid=inventory-workspace] [data-state]').count()) >= 1 && (await page.getByTestId('inventory-totals').count()) === 0)
  await page.unroute('**/api/v1/admin/hotels/*/inventory/summary*')
  await page.route('**/api/v1/admin/hotels/*/inventory/summary*', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue() })
  await page.goto(`${ADMIN}/hotels/${H.palm}?tab=inventory`); await page.waitForSelector('[data-testid=inventory-workspace]', { timeout: 20000 })
  check('a loading state is shown inside the workspace while the summary loads', (await page.locator('[data-testid=inventory-workspace] [aria-busy=true]').count()) >= 1)
  await page.waitForSelector('[data-testid=inventory-totals]', { timeout: 20000 }); await page.unroute('**/api/v1/admin/hotels/*/inventory/summary*')

  // ---- read-only account ------------------------------------------------------------------------------------------------------------
  const viewer = await adminLogin(browser, seed.viewerEmail, { width: 1280, height: 900 })
  await openInventory(viewer.page)
  check('a read-only account sees the pools and stock', (await viewer.page.getByTestId('pool-card').count()) === 1)
  check('and has no create, add, remove, rename, archive or edit controls', (await viewer.page.getByTestId('create-pool').count()) === 0 && (await viewer.page.getByTestId('read-only-note').count()) === 1 && (await viewer.page.getByRole('button', { name: /Remove|Add to pool|Archive pool|Save name|^Edit/ }).count()) === 0)
  await viewer.page.goto(`${ADMIN}/hotels/${H.palm}?tab=inventory`); await viewer.page.waitForSelector('[data-testid=inventory-totals]')
  check('the Quick Update tab is not offered to a read-only account', (await viewer.page.getByRole('tab', { name: 'Quick Update' }).count()) === 0)
  const forbidden = await viewer.page.evaluate(async ([id, tenant]) => (await fetch(`/api/v1/admin/hotels/${id}/inventory/pools`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-fbeds-tenant-id': tenant }, body: JSON.stringify({ name: 'Nope', supplierId: 'x', idempotencyKey: 'abcdefgh12345' }) })).status, [H.palm, seed.tenantA])
  check('a direct mutation by the read-only account is forbidden by the API (403)', forbidden === 403, forbidden)
  const bowner = await adminLogin(browser, seed.bownerEmail)
  const cross = await bowner.page.evaluate(async ([id, tenant]) => (await fetch(`/api/v1/admin/hotels/${id}/inventory/summary`, { credentials: 'include', headers: { 'x-fbeds-tenant-id': tenant } })).status, [H.palm, seed.tenantB])
  check("another tenant cannot read this hotel's inventory (404)", cross === 404, cross)
  await viewer.ctx.close(); await bowner.ctx.close()

  // ---- overflow, keyboard, accessibility -----------------------------------------------------------------------------------------------
  for (const [w, h] of [[1280, 900], [768, 900], [390, 800]]) {
    await page.setViewportSize({ width: w, height: h }); await openInventory(page)
    const o = await overflow(page)
    check(`no page-level horizontal overflow at ${w}px on the Inventory tab`, o <= 1, `overflow=${o}`)
  }
  await page.setViewportSize({ width: 1280, height: 900 }); await openInventory(page)
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  check('axe (WCAG A/AA) finds no violation on the Inventory tab', axe.violations.length === 0, axe.violations.map((v) => `${v.id}:${v.nodes.length}`).join(','))
  check('no uncaught page error', errors.length === 0, errors.join(' | '))
  await ctx.close(); await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
