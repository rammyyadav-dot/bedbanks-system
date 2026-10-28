// Real-stack browser + API verification of Quick Update (ADR 0021 stage 5 / ADR 0067): price (SET, SEASONS, ADJUST percent/amount),
// occupancy-priced rates, availability (allotment, stop-sell, weekday filter), restrictions, the large-price-change guardrail,
// fingerprint staleness, idempotent replay and tenant isolation. Needs: real PostgreSQL (DATABASE_URL = owner connection, used only to
// arrange fixtures and read back results), the API process and the production Admin build (see README.md), and `seed-quick-update.ts`
// run first on a DISPOSABLE database. Re-seed before every run: this script applies real changes. Not run in CI.
const path = require('path')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const apiReq = createRequire(path.join(__dirname, '../../apps/api/package.json'))
const { PrismaClient } = apiReq('@prisma/client')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-quick-update.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const prisma = new PrismaClient()
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`) }
const DAY = 86_400_000
const iso = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10)
const row = (page, code) => page.locator('tr[data-plan-id]').filter({ has: page.locator(`code:text-is("${code}")`) })
// Mirrors the service's half-away-from-zero basis-point adjustment exactly, in BigInt (CLAUDE.md invariant 3: no floats in pricing).
const adjustPercent = (amountMinor, bp) => amountMinor + (amountMinor * BigInt(bp) + (bp >= 0 ? 5000n : -5000n)) / 10000n

async function login(browser, email) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}

async function setScope(page, { plans, from, to, weekdays }) {
  // Clears any prior selection by changing the room filter back to "All rooms" first is unnecessary; select checkboxes directly.
  for (const code of plans) { const box = row(page, code).getByRole('checkbox'); if (!(await box.isChecked())) await box.check() }
  await page.getByLabel('From').first().fill(from)
  await page.getByLabel('To').first().fill(to)
  for (const w of weekdays ?? []) await page.getByRole('group', { name: 'Weekdays' }).getByRole('checkbox', { name: w }).check()
}
async function clearForm(page) {
  await page.goto(`${BASE}/hotels/${seed.hotelId}?tab=quick`)
  await page.waitForSelector('[data-testid=quick-update]')
}

;(async () => {
  const browser = await chromium.launch()
  const { ctx, page } = await login(browser, seed.ownerEmail)
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  let lastApplyBody = null
  page.on('request', (r) => { if (/\/quick-update\/apply$/.test(r.url()) && r.method() === 'POST') { try { lastApplyBody = JSON.parse(r.postData()) } catch { /* ignore */ } } })

  await clearForm(page)

  // ---- SET price across two plans, two ranges of a multi-plan scope ----------------------------------------------------------
  await setScope(page, { plans: [seed.mainCode, seed.secondCode], from: iso(5), to: iso(10) })
  await page.locator('fieldset[data-panel=price] input[type=checkbox]').check()
  await page.getByLabel('Amount per night (AED)').fill('650.00')
  await page.getByTestId('qu-preview').click()
  await page.waitForSelector('[data-testid=qu-preview-result]')
  const counts1 = await page.getByTestId('qu-counts').innerText()
  check('SET price preview: 12 records (2 plans x 6 nights), all will change', /12 records? over 6 night/.test(counts1) && /12 will change/.test(counts1), counts1)
  check('no large-price-change warning for a +30% move', (await page.locator('[data-testid=large-price-changes]').count()) === 0)
  await page.getByLabel(/^Reason/).fill('Quick Update certification: SET price')
  await page.getByTestId('qu-apply').click()
  await page.waitForSelector('[data-testid=qu-result]', { timeout: 15000 })
  const applyKey1 = lastApplyBody?.idempotencyKey
  const r1 = await prisma.dailyRate.findMany({ where: { tenantId: seed.tenantA, ratePlanId: { in: [seed.plans.main, seed.plans.second] }, stayDate: { gte: new Date(`${iso(5)}T00:00:00.000Z`), lte: new Date(`${iso(10)}T00:00:00.000Z`) }, occupancy: 2 } })
  check('DB: SET price wrote AED 650.00 (65000 minor) to all 12 rows, integer minor units only', r1.length === 12 && r1.every((x) => x.amountMinor === 65000n))
  const auditRows1 = await prisma.auditEvent.findMany({ where: { tenantId: seed.tenantA, entityId: seed.hotelId, action: 'hotel.quick_update.applied', payload: { path: ['idempotencyKey'], equals: applyKey1 } } })
  check('exactly one audit event recorded for this apply (CLAUDE.md invariant 8)', auditRows1.length === 1 && auditRows1[0].payload.outcome === 'allowed')

  // ---- idempotent replay: the same idempotencyKey direct against the API never double-writes -----------------------------------
  const replay = await page.request.post(`${BASE}/api/v1/admin/hotels/${seed.hotelId}/quick-update/apply`, { data: lastApplyBody, headers: { 'content-type': 'application/json', origin: BASE } })
  const replayBody = await replay.json()
  check('replaying the same idempotencyKey returns replayed:true with the original counts', replay.status() === 200 && replayBody.data.replayed === true && replayBody.data.records === 12)
  const auditRows1b = await prisma.auditEvent.findMany({ where: { tenantId: seed.tenantA, entityId: seed.hotelId, action: 'hotel.quick_update.applied', payload: { path: ['idempotencyKey'], equals: applyKey1 } } })
  check('replay created no second audit event and wrote nothing twice', auditRows1b.length === 1)

  // ---- fingerprint staleness: a concurrent edit between preview and apply is rejected, nothing written -----------------------
  await clearForm(page)
  await setScope(page, { plans: [seed.mainCode], from: iso(15), to: iso(18) })
  await page.locator('fieldset[data-panel=availability] input[type=checkbox]').check()
  await page.getByLabel(/^Allotment/).fill('7')
  await page.getByTestId('qu-preview').click()
  await page.waitForSelector('[data-testid=qu-preview-result]')
  // Someone else changes the same inventory row directly in the database after the preview was taken.
  await prisma.dailyAvailability.updateMany({ where: { tenantId: seed.tenantA, ratePlanId: seed.plans.main, stayDate: new Date(`${iso(15)}T00:00:00.000Z`) }, data: { allotment: 12 } })
  await page.getByLabel(/^Reason/).fill('Quick Update certification: staleness')
  await page.getByTestId('qu-apply').click()
  await page.waitForSelector('[data-testid=qu-error]', { timeout: 15000 })
  const staleError = await page.getByTestId('qu-error').innerText()
  check('a concurrent edit between preview and apply is refused as stale, not silently overwritten', /changed after you previewed/.test(staleError))
  const staleRow = await prisma.dailyAvailability.findFirst({ where: { tenantId: seed.tenantA, ratePlanId: seed.plans.main, stayDate: new Date(`${iso(15)}T00:00:00.000Z`) } })
  check('the stale apply attempt wrote nothing: the concurrent value (12) stands', staleRow.allotment === 12)

  // ---- large price change guardrail (ADR 0067 F-13): needs an explicit confirmation ------------------------------------------
  await clearForm(page)
  await setScope(page, { plans: [seed.mainCode], from: iso(20), to: iso(22) })
  await page.locator('fieldset[data-panel=price] input[type=checkbox]').check()
  await page.getByLabel('Amount per night (AED)').fill('1000.00')
  await page.getByTestId('qu-preview').click()
  await page.waitForSelector('[data-testid=qu-preview-result]')
  check('preview flags a +100% move as a large price change', (await page.locator('[data-testid=large-price-changes]').count()) === 1)
  await page.getByLabel(/^Reason/).fill('Quick Update certification: guardrail')
  check('Apply stays disabled until the large-change box is ticked', await page.getByTestId('qu-apply').isDisabled())
  await page.locator('[data-testid=large-price-changes] input[type=checkbox]').check()
  await page.getByTestId('qu-apply').click()
  await page.waitForSelector('[data-testid=qu-result]', { timeout: 15000 })
  const r2 = await prisma.dailyRate.findMany({ where: { tenantId: seed.tenantA, ratePlanId: seed.plans.main, stayDate: { gte: new Date(`${iso(20)}T00:00:00.000Z`), lte: new Date(`${iso(22)}T00:00:00.000Z`) }, occupancy: 2 } })
  check('DB: the confirmed large change wrote AED 1000.00 to all 3 nights', r2.length === 3 && r2.every((x) => x.amountMinor === 100_000n))
  const guardAudit = await prisma.auditEvent.findFirst({ where: { tenantId: seed.tenantA, entityId: seed.hotelId, action: 'hotel.quick_update.applied', payload: { path: ['idempotencyKey'], equals: lastApplyBody.idempotencyKey } } })
  check('audit event records confirmedLargeChanges:true', guardAudit.payload.confirmedLargeChanges === true && guardAudit.payload.largePriceChanges === 3)

  // ---- adjust by percent and by amount (half-up basis-point math, keeps the stored basis) --------------------------------------
  await clearForm(page)
  await setScope(page, { plans: [seed.mainCode], from: iso(25), to: iso(27) })
  await page.locator('fieldset[data-panel=price] input[type=checkbox]').check()
  await page.getByLabel('How').selectOption({ label: 'Adjust stored rates by a percent' })
  await page.getByLabel(/^Change \(percent/).fill('+10')
  await page.getByTestId('qu-preview').click(); await page.waitForSelector('[data-testid=qu-preview-result]')
  await page.getByLabel(/^Reason/).fill('Quick Update certification: percent adjust')
  await page.getByTestId('qu-apply').click(); await page.waitForSelector('[data-testid=qu-result]', { timeout: 15000 })
  const r3 = await prisma.dailyRate.findMany({ where: { tenantId: seed.tenantA, ratePlanId: seed.plans.main, stayDate: new Date(`${iso(25)}T00:00:00.000Z`), occupancy: 2 } })
  check('DB: +10% adjust on AED 500.00 writes AED 550.00 exactly (BigInt half-up basis points)', r3[0].amountMinor === adjustPercent(50_000n, 1000))

  await clearForm(page)
  await setScope(page, { plans: [seed.mainCode], from: iso(30), to: iso(30) })
  await page.locator('fieldset[data-panel=price] input[type=checkbox]').check()
  await page.getByLabel('How').selectOption({ label: 'Adjust stored rates by an amount' })
  await page.getByLabel(/^Change per night/).fill('-25.00')
  await page.getByTestId('qu-preview').click(); await page.waitForSelector('[data-testid=qu-preview-result]')
  await page.getByLabel(/^Reason/).fill('Quick Update certification: amount adjust')
  await page.getByTestId('qu-apply').click(); await page.waitForSelector('[data-testid=qu-result]', { timeout: 15000 })
  const r4 = await prisma.dailyRate.findFirst({ where: { tenantId: seed.tenantA, ratePlanId: seed.plans.main, stayDate: new Date(`${iso(30)}T00:00:00.000Z`), occupancy: 2 } })
  check('DB: -25.00 amount adjust on AED 500.00 writes AED 475.00 exactly', r4.amountMinor === 47_500n)

  // ---- seasons: a price per non-overlapping date window --------------------------------------------------------------------
  await clearForm(page)
  await setScope(page, { plans: [seed.mainCode], from: iso(35), to: iso(44) })
  await page.locator('fieldset[data-panel=price] input[type=checkbox]').check()
  await page.getByLabel('How').selectOption({ label: 'Load seasons (a price per date window)' })
  await page.getByLabel('Season 1 from').fill(iso(35)); await page.getByLabel('Season 1 to').fill(iso(39)); await page.getByLabel('Season 1 amount').fill('700.00')
  await page.getByRole('button', { name: 'Add season' }).click()
  await page.getByLabel('Season 2 from').fill(iso(40)); await page.getByLabel('Season 2 to').fill(iso(44)); await page.getByLabel('Season 2 amount').fill('800.00')
  await page.getByTestId('qu-preview').click(); await page.waitForSelector('[data-testid=qu-preview-result]')
  await page.getByLabel(/^Reason/).fill('Quick Update certification: seasons')
  await page.getByTestId('qu-apply').click(); await page.waitForSelector('[data-testid=qu-result]', { timeout: 15000 })
  const season1 = await prisma.dailyRate.findFirst({ where: { tenantId: seed.tenantA, ratePlanId: seed.plans.main, stayDate: new Date(`${iso(37)}T00:00:00.000Z`), occupancy: 2 } })
  const season2 = await prisma.dailyRate.findFirst({ where: { tenantId: seed.tenantA, ratePlanId: seed.plans.main, stayDate: new Date(`${iso(42)}T00:00:00.000Z`), occupancy: 2 } })
  check('DB: season 1 night priced at AED 700.00', season1.amountMinor === 70_000n)
  check('DB: season 2 night priced at AED 800.00 (non-overlapping windows)', season2.amountMinor === 80_000n)

  // ---- occupancy-priced rate (ADR 0067 F-05): a separate occupancy, the plan's own rows untouched -------------------------------
  const before2 = await prisma.dailyRate.findFirst({ where: { tenantId: seed.tenantA, ratePlanId: seed.plans.main, stayDate: new Date(`${iso(46)}T00:00:00.000Z`), occupancy: 2 } })
  await clearForm(page)
  await setScope(page, { plans: [seed.mainCode], from: iso(45), to: iso(47) })
  await page.locator('fieldset[data-panel=price] input[type=checkbox]').check()
  await page.getByLabel('Amount per night (AED)').fill('300.00')
  await page.getByLabel('Occupancy priced').selectOption({ label: '1 adult (single)' })
  await page.getByTestId('qu-preview').click(); await page.waitForSelector('[data-testid=qu-preview-result]')
  await page.getByLabel(/^Reason/).fill('Quick Update certification: occupancy-priced rate')
  await page.getByTestId('qu-apply').click(); await page.waitForSelector('[data-testid=qu-result]', { timeout: 15000 })
  const occ1 = await prisma.dailyRate.findMany({ where: { tenantId: seed.tenantA, ratePlanId: seed.plans.main, stayDate: { gte: new Date(`${iso(45)}T00:00:00.000Z`), lte: new Date(`${iso(47)}T00:00:00.000Z`) }, occupancy: 1 } })
  const occ2after = await prisma.dailyRate.findFirst({ where: { tenantId: seed.tenantA, ratePlanId: seed.plans.main, stayDate: new Date(`${iso(46)}T00:00:00.000Z`), occupancy: 2 } })
  check('DB: single-occupancy rows created at AED 300.00, a new occupancy row per night', occ1.length === 3 && occ1.every((x) => x.amountMinor === 30_000n))
  check("the plan's own occupancy-2 rate is untouched by an occupancy-priced change", occ2after.amountMinor === before2.amountMinor)

  // ---- weekday filter + stop-sell SET then CLEAR -------------------------------------------------------------------------------
  await clearForm(page)
  await setScope(page, { plans: [seed.mainCode], from: iso(50), to: iso(63), weekdays: ['SAT', 'SUN'] })
  await page.locator('fieldset[data-panel=availability] input[type=checkbox]').check()
  await page.getByLabel('Stop-sell').selectOption({ label: 'Set stop-sell' })
  await page.getByTestId('qu-preview').click(); await page.waitForSelector('[data-testid=qu-preview-result]')
  await page.getByLabel(/^Reason/).fill('Quick Update certification: weekday stop-sell')
  await page.getByTestId('qu-apply').click(); await page.waitForSelector('[data-testid=qu-result]', { timeout: 15000 })
  const weekendRows = await prisma.dailyAvailability.findMany({ where: { tenantId: seed.tenantA, ratePlanId: seed.plans.main, stayDate: { gte: new Date(`${iso(50)}T00:00:00.000Z`), lte: new Date(`${iso(63)}T00:00:00.000Z`) } } })
  const isWeekend = (d) => [0, 6].includes(d.getUTCDay())
  check('weekday filter: only Saturday/Sunday nights in the range were stopped, weekdays untouched', weekendRows.every((r) => r.stopSell === isWeekend(r.stayDate)) && weekendRows.some((r) => isWeekend(r.stayDate)) && weekendRows.some((r) => !isWeekend(r.stayDate)))

  await clearForm(page)
  await setScope(page, { plans: [seed.mainCode], from: iso(50), to: iso(63), weekdays: ['SAT', 'SUN'] })
  await page.locator('fieldset[data-panel=availability] input[type=checkbox]').check()
  await page.getByLabel('Stop-sell').selectOption({ label: 'Clear stop-sell' })
  await page.getByTestId('qu-preview').click(); await page.waitForSelector('[data-testid=qu-preview-result]')
  await page.getByLabel(/^Reason/).fill('Quick Update certification: clear stop-sell')
  await page.getByTestId('qu-apply').click(); await page.waitForSelector('[data-testid=qu-result]', { timeout: 15000 })
  const cleared = await prisma.dailyAvailability.count({ where: { tenantId: seed.tenantA, ratePlanId: seed.plans.main, stayDate: { gte: new Date(`${iso(50)}T00:00:00.000Z`), lte: new Date(`${iso(63)}T00:00:00.000Z`) }, stopSell: true } })
  check('CLEAR stop-sell removes it from every weekend night previously set', cleared === 0)

  // ---- restrictions: minStay, closed to arrival, release override -------------------------------------------------------------
  await clearForm(page)
  await setScope(page, { plans: [seed.secondCode], from: iso(70), to: iso(72) })
  await page.locator('fieldset[data-panel=restrictions] input[type=checkbox]').check()
  await page.getByLabel(/^Minimum stay/).fill('3')
  await page.getByLabel(/^Closed to arrival/).selectOption({ label: 'Close to arrival' })
  await page.getByLabel(/^Release/).fill('2')
  await page.getByTestId('qu-preview').click(); await page.waitForSelector('[data-testid=qu-preview-result]')
  await page.getByLabel(/^Reason/).fill('Quick Update certification: restrictions')
  await page.getByTestId('qu-apply').click(); await page.waitForSelector('[data-testid=qu-result]', { timeout: 15000 })
  const restr = await prisma.dailyAvailability.findMany({ where: { tenantId: seed.tenantA, ratePlanId: seed.plans.second, stayDate: { gte: new Date(`${iso(70)}T00:00:00.000Z`), lte: new Date(`${iso(72)}T00:00:00.000Z`) } } })
  check('DB: minStay, closedToArrival and releaseDays override all written exactly', restr.length === 3 && restr.every((x) => x.minStay === 3 && x.closedToArrival === true && x.releaseDays === 2))

  // ---- a mixed-currency scope is refused before anything is written ------------------------------------------------------------
  await clearForm(page)
  await setScope(page, { plans: [seed.mainCode, seed.gbpCode], from: iso(5), to: iso(6) })
  await page.locator('fieldset[data-panel=price] input[type=checkbox]').check()
  await page.getByLabel(/^Amount per night/).fill('650.00')
  await page.getByTestId('qu-preview').click()
  await page.waitForSelector('[data-testid=qu-preview-result]')
  const mixedErrors = await page.getByTestId('qu-errors').innerText().catch(() => '')
  check('a price change across two currencies in one scope is refused with a clear reason, nothing applicable', /one currency/.test(mixedErrors), mixedErrors)
  check('no uncaught page errors so far', errors.length === 0, errors.join(' | '))
  await ctx.close()

  // ---- permission boundary: a user without supply.rates.manage cannot change price, even directly ------------------------------
  const viewer = await login(browser, seed.viewerEmail)
  await viewer.page.goto(`${BASE}/hotels/${seed.hotelId}?tab=quick`)
  await viewer.page.waitForSelector('[data-testid=quick-update]')
  const priceCheckbox = viewer.page.locator('fieldset[data-panel=price] input[type=checkbox]')
  check('a viewer without supply.rates.manage sees the price panel disabled with the reason', await priceCheckbox.isDisabled() && /need the rates permission/.test(await viewer.page.locator('fieldset[data-panel=price]').innerText()))
  const directDenied = await viewer.page.request.post(`${BASE}/api/v1/admin/hotels/${seed.hotelId}/quick-update/apply`, {
    data: { scope: { ratePlanIds: [seed.plans.main], ranges: [{ from: iso(80), to: iso(80) }] }, changes: { price: { amount: '999.00', basis: 'SELL' } }, idempotencyKey: `perm-${Date.now().toString(36)}`, expectedFingerprint: '0'.repeat(64), reason: 'should be refused' },
    headers: { 'content-type': 'application/json', origin: BASE },
  })
  check('a direct apply call without supply.rates.manage is refused (403), nothing written', directDenied.status() === 403, String(directDenied.status()))
  const untouched80 = await prisma.dailyRate.findFirst({ where: { tenantId: seed.tenantA, ratePlanId: seed.plans.main, stayDate: new Date(`${iso(80)}T00:00:00.000Z`), occupancy: 2 } })
  check('the refused call left the stored rate exactly as seeded (AED 500.00)', untouched80.amountMinor === 50_000n)
  await viewer.ctx.close()

  // ---- tenant isolation: tenant B cannot preview or apply against tenant A's hotel --------------------------------------------
  const b = await login(browser, seed.bownerEmail)
  const crossPreview = await b.page.request.post(`${BASE}/api/v1/admin/hotels/${seed.hotelId}/quick-update/preview`, {
    data: { scope: { ratePlanIds: [seed.plans.main], ranges: [{ from: iso(81), to: iso(81) }] }, changes: { price: { amount: '1.00', basis: 'SELL' } } },
    headers: { 'content-type': 'application/json', origin: BASE },
  })
  check("tenant B previewing tenant A's hotel gets not-found, never another tenant's data", crossPreview.status() === 404, String(crossPreview.status()))
  const crossApply = await b.page.request.post(`${BASE}/api/v1/admin/hotels/${seed.hotelId}/quick-update/apply`, {
    data: { scope: { ratePlanIds: [seed.plans.main], ranges: [{ from: iso(81), to: iso(81) }] }, changes: { price: { amount: '1.00', basis: 'SELL' } }, idempotencyKey: `cross-${Date.now().toString(36)}`, expectedFingerprint: '0'.repeat(64), reason: 'cross-tenant attempt' },
    headers: { 'content-type': 'application/json', origin: BASE },
  })
  check("tenant B applying against tenant A's hotel gets not-found, writes nothing", crossApply.status() === 404, String(crossApply.status()))
  const untouched81 = await prisma.dailyRate.findFirst({ where: { tenantId: seed.tenantA, ratePlanId: seed.plans.main, stayDate: new Date(`${iso(81)}T00:00:00.000Z`), occupancy: 2 } })
  check("tenant A's rate for that night is unaffected by tenant B's attempt", untouched81.amountMinor === 50_000n)
  await b.ctx.close()

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) { console.log('FAILED:\n' + failed.map((f) => ' - ' + f.name).join('\n')); process.exit(1) }
  await prisma.$disconnect()
})().catch(async (e) => { console.error('FAIL  aborted:', String(e.message ?? e).split('\n')[0]); await prisma.$disconnect().catch(() => {}); process.exit(1) })
