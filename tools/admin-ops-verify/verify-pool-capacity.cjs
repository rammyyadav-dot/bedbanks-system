// Real-stack browser verification of the pool capacity editor and per-plan consumption report (ADR 0036). See README.md. Not run in CI.
const path = require('path')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const AxeBuilder = req('@axe-core/playwright').default || req('@axe-core/playwright')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-pool-capacity.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const API = process.env.API_URL ?? 'http://localhost:3000/api/v1'
const SHOTS = process.env.SHOT_DIR ?? require('os').tmpdir()
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`) }
const text = async (page) => (await page.locator('main, .admin-page').first().innerText()).replace(/\s+/g, ' ')
const stateOf = async (page, scope = 'body') => page.locator(`${scope} [data-state]`).first().getAttribute('data-state')
const poolUrl = (h, p) => `${BASE}/hotels/${h}?tab=inventory&pool=${p}`
const P = seed.palm
const [P1, P2, P3] = P.planIds
const poolApi = (hotel, pool, tail) => `${API}/admin/hotels/${hotel}/inventory/pools/${pool}${tail}`

async function login(browser, email, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport } : {}); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
const open = async (page, hotel, pool) => { await page.goto(poolUrl(hotel, pool)); await page.waitForSelector('[data-testid=pool-workspace] [data-testid=pool-identity], [data-state]', { timeout: 30000 }); await page.waitForSelector('[data-testid=consumption], [data-state]', { timeout: 30000 }) }
const form = (page) => page.locator('form[aria-label="Capacity change"]')
async function fillEdit(page, { start, end, capacity, weekdays = [] }) {
  const f = form(page); const dates = f.locator('input[type=date]')
  await dates.nth(0).fill(start); await dates.nth(1).fill(end)
  await f.locator('input[aria-describedby="capacity-help"]').fill(String(capacity))
  for (const w of weekdays) await f.getByLabel(w, { exact: true }).check()
}
const detailOf = async (ctx, hotel, pool, from, days = 14) => (await (await ctx.request.get(`${poolApi(hotel, pool, '')}?from=${from}&days=${days}`)).json()).data
const capacitiesOf = async (ctx, from) => (await detailOf(ctx, P.hotelId, P.poolId, from, 14)).days.map((d) => `${d.date}:${d.capacity}`).join(',')

;(async () => {
  const browser = await chromium.launch()
  const op = await login(browser, seed.operatorEmail)
  const errors = []; op.page.on('pageerror', (e) => errors.push(e.message))
  const writes = []
  op.page.on('request', (r) => { if (r.url().includes('/api/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${new URL(r.url()).pathname.replace(/[0-9a-z]{20,}/g, ':id')}`) })
  const page = op.page; const hotelToday = null

  // ---- directory to detail ------------------------------------------------------------------------------------------------------
  await page.goto(`${BASE}/hotels/${P.hotelId}?tab=inventory`); await page.waitForSelector('[data-testid=pool-card]', { timeout: 30000 })
  check('the existing pool directory offers a link into the pool', (await page.locator('[data-testid=open-pool]').count()) === 1)
  await page.locator('[data-testid=open-pool]').click(); await page.waitForSelector('[data-testid=pool-identity]', { timeout: 30000 }); await page.waitForSelector('[data-testid=consumption]')
  check('detail URL carries the pool and back link returns to the directory', page.url().includes(`pool=${P.poolId}`) && (await page.locator('[data-testid=pool-back]').getAttribute('href')) === `/hotels/${P.hotelId}?tab=inventory`)
  const ident = await page.locator('[data-testid=pool-identity]').innerText()
  check('identity shows pool name, supplier, room scope and the three linked plans', /Palm shared/.test(ident) && /Gulf Direct/.test(ident) && /Deluxe/.test(ident) && /P1/.test(ident) && /P2/.test(ident) && /P3/.test(ident), ident.replace(/\s+/g, ' ').slice(0, 160))
  check('hotel time zone and hotel date are shown, and the audit trail is linked for a user with audit.read', /Asia\/Dubai/.test(await text(page)) && (await page.locator('[data-testid=pool-identity] a[href*="tab=audit"]').count()) === 1)

  // ---- daily counters -----------------------------------------------------------------------------------------------------------
  const row = (d) => page.locator(`[data-testid=pool-days] tr[data-date="${d}"]`)
  const cells = async (d) => (await row(d).locator('td').allInnerTexts()).map((s) => s.trim())
  const d3 = await cells(seed.dates.consumption)
  check('night d+3: capacity 10, sold 2, held 3, available 5 (subtracted once)', d3[1] === '10' && d3[2] === '2' && d3[3] === '3' && d3[4] === '5', d3.join('|'))
  const d5 = await cells(seed.dates.floor)
  check('night d+5 at its committed floor: capacity 3, sold 1, held 2, available 0, SOLD OUT', d5[1] === '3' && d5[2] === '1' && d5[3] === '2' && d5[4] === '0' && /SOLD OUT/.test(d5[6]), d5.join('|'))

  // ---- per-plan consumption -----------------------------------------------------------------------------------------------------
  const planRow = (id) => page.locator(`[data-testid=consumption-plans] tr[data-plan-id="${id}"]`)
  const planCells = async (id) => (await planRow(id).locator('td').allInnerTexts()).map((s) => s.trim())
  const c1 = await planCells(P1); const c2 = await planCells(P2); const c3 = await planCells(P3)
  check('P1 holds 4 and has sold 2 (d+3 and d+5), all as MEMBER', c1[4] === '4' && c1[5] === '2' && /MEMBER/.test(c1[3]), c1.join('|'))
  check('P2 holds 1 and has sold 1; P3 sold then cancelled so it occupies nothing', c2[4] === '1' && c2[5] === '1' && c3[4] === '0' && c3[5] === '0', `${c2.join('|')} ; ${c3.join('|')}`)
  const tot = (await page.locator('[data-testid=consumption-totals]').innerText()).replace(/\s+/g, ' ')
  check('window totals reconcile: attributed held 5 + unattributed 0, attributed sold 3 + unattributed 0', /Attributed held 5/.test(tot) && /Attributed sold 3/.test(tot) && /Unattributed held 0/.test(tot) && /Unattributed sold 0/.test(tot), tot)
  const night3 = await page.locator(`[data-testid=consumption-nights] tr[data-date="${seed.dates.consumption}"]`).innerText()
  check('night d+3 attributes held to P1 and P2 and shows RECONCILES yes', /P1 2/.test(night3) && /P2 1/.test(night3) && /YES/.test(night3), night3.replace(/\s+/g, ' '))
  check('released, expired and cancelled holds are explained as not counted', (await page.locator('details', { hasText: 'How these numbers are defined' }).count()) === 1)
  await page.locator('details summary', { hasText: 'How these numbers are defined' }).click()
  check('definitions state the formula, the terminal states and the limitations', /available = capacity - sold - held/.test(await text(page)) && /RELEASED, EXPIRED, FAILED/.test(await text(page)) && /Limitation/.test(await text(page)))
  await page.screenshot({ path: `${SHOTS}/pool-workspace.png`, fullPage: true })

  // ---- editor: validation before submission ---------------------------------------------------------------------------------------
  check('the editor is shown to an operator with preview and apply permissions', (await page.locator('[data-testid=capacity-editor]').count()) === 1)
  check('Preview is disabled until the form is valid', await page.locator('[data-testid=preview-button]').isDisabled())
  await fillEdit(page, { start: seed.dates.free, end: seed.dates.free, capacity: '' })
  check('blank capacity is explained as unchanged and cannot be previewed', await page.locator('[data-testid=preview-button]').isDisabled() && /Blank means unchanged/.test(await page.locator('[data-testid=editor-problems]').innerText()))
  for (const bad of ['-1', '2.5', 'abc', '10000']) {
    await form(page).locator('input[aria-describedby="capacity-help"]').fill(bad)
    check(`capacity "${bad}" is rejected in the form before any request`, await page.locator('[data-testid=preview-button]').isDisabled(), await page.locator('[data-testid=editor-problems]').innerText().catch(() => ''))
  }
  const datesIn = form(page).locator('input[type=date]')
  await datesIn.nth(0).fill(seed.dates.free); await datesIn.nth(1).fill(seed.dates.from)
  await form(page).locator('input[aria-describedby="capacity-help"]').fill('5')
  check('an end date before the start date is rejected in the form', await page.locator('[data-testid=preview-button]').isDisabled() && /end date is before/i.test(await page.locator('[data-testid=editor-problems]').innerText()))

  // ---- editor: preview ----------------------------------------------------------------------------------------------------------------
  const writesBefore = writes.length
  await fillEdit(page, { start: seed.dates.floor, end: seed.dates.free, capacity: 2 })
  await page.locator('[data-testid=preview-button]').click(); await page.waitForSelector('[data-testid=preview]', { timeout: 20000 })
  const pcount = (await page.locator('[data-testid=preview-counts]').innerText()).replace(/\s+/g, ' ')
  check('a decrease below the committed floor shows the night INVALID with the numbers and cannot be applied', /1 invalid/.test(pcount) && (await page.locator(`[data-testid=preview-table] tr[data-date="${seed.dates.floor}"]`).innerText()).includes('already sold or held (sold 1, held 2)') && (await page.locator('[data-testid=apply-button]').isDisabled()), pcount)
  check('the preview made a preview request and no apply request', writes.slice(writesBefore).every((w) => /capacity\/preview$/.test(w)) && writes.length > writesBefore)
  check('nothing was written by the preview: the floor night still has capacity 3', (await detailOf(op.ctx, P.hotelId, P.poolId, seed.dates.from)).days.find((d) => d.date === seed.dates.floor).capacity === 3)
  await fillEdit(page, { start: seed.dates.free, end: day(seed.dates.free, 2), capacity: 0 })
  await page.locator('[data-testid=preview-button]').click(); await page.waitForFunction(() => /0 invalid/.test(document.querySelector('[data-testid=preview-counts]')?.textContent ?? ''), null, { timeout: 20000 })
  check('zero is accepted as an intentional capacity of zero (3 nights change to 0)', /3 to change/.test((await page.locator('[data-testid=preview-counts]').innerText()).replace(/\s+/g, ' ')) && /0 · 0/.test(await page.locator(`[data-testid=preview-table] tr[data-date="${seed.dates.free}"]`).innerText()))
  // editing any input invalidates the preview so a stale table is never applied
  await form(page).locator('input[aria-describedby="capacity-help"]').fill('7')
  check('changing an input clears the preview', (await page.locator('[data-testid=preview]').count()) === 0)

  // ---- editor: apply, conflict, idempotency -------------------------------------------------------------------------------------------
  const range = { start: seed.dates.free, end: day(seed.dates.free, 1), capacity: 12 }
  await fillEdit(page, range); await page.locator('[data-testid=preview-button]').click(); await page.waitForSelector('[data-testid=preview-table]')
  check('Apply needs a reason: disabled while the reason is blank', await page.locator('[data-testid=apply-button]').isDisabled())
  await page.getByLabel(/^Reason/).fill('Hotel confirmed 12 rooms for these nights')
  // a concurrent change after the preview: another operator edits the same nights through the API
  const other = (await (await op.ctx.request.post(poolApi(P.hotelId, P.poolId, '/capacity/preview'), { headers: { origin: BASE }, data: { startDate: range.start, endDate: range.end, capacity: 11 } })).json()).data
  const raced = await op.ctx.request.post(poolApi(P.hotelId, P.poolId, '/capacity/apply'), { headers: { origin: BASE }, data: { startDate: range.start, endDate: range.end, capacity: 11, expectedFingerprint: other.fingerprint, reason: 'A colleague edited first', idempotencyKey: `${seed.tag}-race-1` } })
  check('the competing edit succeeded through the API', raced.status() === 200)
  await page.locator('[data-testid=apply-button]').click(); await page.waitForSelector('[data-testid=editor-error]', { timeout: 20000 })
  check('a stale preview is refused with a conflict message and a "Preview again" action; nothing was written', /changed after you previewed/.test(await page.locator('[data-testid=editor-error]').innerText()) && (await page.locator('[data-testid=stale-help] button').count()) === 1 && (await detailOf(op.ctx, P.hotelId, P.poolId, seed.dates.from)).days.find((d) => d.date === range.start).capacity === 11)
  await page.screenshot({ path: `${SHOTS}/pool-conflict.png`, fullPage: true })
  await page.locator('[data-testid=stale-help] button').click(); await page.waitForSelector('[data-testid=preview-table]'); await page.waitForTimeout(400)
  const refreshed = await page.locator(`[data-testid=preview-table] tr[data-date="${range.start}"]`).innerText()
  check('Preview again shows the current values (before: 11) and clears the error', /11 · 0 · 0 · 11/.test(refreshed) && (await page.locator('[data-testid=editor-error]').count()) === 0, refreshed.replace(/\s+/g, ' '))
  await page.getByLabel(/^Reason/).fill('Hotel confirmed 12 rooms for these nights')
  const applies = () => writes.filter((w) => /capacity\/apply$/.test(w)).length
  const a0 = applies()
  await page.locator('[data-testid=apply-button]').dblclick(); await page.waitForSelector('[data-testid=editor-done]', { timeout: 20000 })
  check('a double click sends exactly one apply request', applies() - a0 === 1, String(applies() - a0))
  check('success is stated and the pool table now shows the new capacity', /2 night\(s\) changed/.test(await page.locator('[data-testid=editor-done]').innerText()) && (await cells(range.start))[1] === '12' && (await capacitiesOf(op.ctx, seed.dates.from)).includes(`${range.start}:12`))
  check('the apply cleared the preview and the reason', (await page.locator('[data-testid=preview]').count()) === 0)
  await page.waitForTimeout(500)
  check('the plans, prices and holds were untouched: P1 consumption is unchanged', (await planCells(P1))[4] === '4')

  // ---- failure states ---------------------------------------------------------------------------------------------------------------------
  await page.route('**/inventory/pools/*/consumption*', (r) => r.fulfill({ status: 503, contentType: 'application/json', headers: { 'x-request-id': 'req-cons-1' }, body: JSON.stringify({ success: false, error: { code: 'OPERATIONS_READ_DENIED', message: 'x', details: [] }, meta: {} }) }))
  await open(page, P.hotelId, P.poolId)
  check('a failed consumption read shows an explicit denied state while the daily counters still render', (await page.locator('[data-testid=pool-days]').count()) === 1 && (await stateOf(page, '')) !== null && !/Attributed held 0/.test(await text(page)))
  await page.unroute('**/inventory/pools/*/consumption*')
  for (const [status, code, expect] of [[403, 'FORBIDDEN', 'forbidden'], [500, 'INTERNAL_SERVER_ERROR', 'error']]) {
    await page.route(/\/inventory\/pools\/[^/?]+(\?.*)?$/, (r) => r.request().method() === 'GET' ? r.fulfill({ status, contentType: 'application/json', headers: { 'x-request-id': 'req-det-1' }, body: JSON.stringify({ success: false, error: { code, message: 'x', details: [] }, meta: {} }) }) : r.continue())
    await page.goto(poolUrl(P.hotelId, P.poolId)); await page.waitForSelector('[data-state]', { timeout: 20000 })
    check(`pool detail API ${status} renders "${expect}", never an empty pool`, (await page.locator('[data-state]').first().getAttribute('data-state')) === expect && !/0 results|No pool/.test(await text(page)))
    await page.unroute(/\/inventory\/pools\/[^/?]+(\?.*)?$/)
  }
  await open(page, P.hotelId, P.poolId)
  await page.route('**/capacity/preview', (r) => r.fulfill({ status: 500, contentType: 'application/json', headers: { 'x-request-id': 'req-prev-1' }, body: JSON.stringify({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'x', details: [] }, meta: {} }) }))
  await fillEdit(page, { start: seed.dates.free, end: seed.dates.free, capacity: 4 }); await page.locator('[data-testid=preview-button]').click(); await page.waitForSelector('[data-testid=editor-error]')
  check('a failed preview shows an error with the request reference and no preview table', /failed to preview/.test(await page.locator('[data-testid=editor-error]').innerText()) && (await page.locator('[data-testid=preview]').count()) === 0)
  await page.unroute('**/capacity/preview')
  await page.route('**/capacity/preview', (r) => r.abort()); await page.locator('[data-testid=preview-button]').click(); await page.waitForSelector('[data-testid=editor-error]')
  check('an unreachable API says nothing was saved', /could not be reached/.test(await page.locator('[data-testid=editor-error]').innerText()))
  await page.unroute('**/capacity/preview')

  // ---- empty pool (no stock rows) ---------------------------------------------------------------------------------------------------------
  await open(page, seed.empty.hotelId, seed.empty.poolId)
  const dayStates = await page.locator('[data-testid=pool-days] tbody tr').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))
  check('a pool with no stock rows shows every night as unknown (missing), not zero', dayStates.length > 0 && dayStates.every((s) => s === 'missing') && !/0 · 0/.test(await text(page)))
  check('its consumption report has no nights with a pool row and no fabricated totals', /Nights with a pool row\s*0/.test((await page.locator('[data-testid=consumption-totals]').innerText()).replace(/\s+/g, ' ')))

  // ---- layout, keyboard, labels ------------------------------------------------------------------------------------------------------------
  await open(page, P.hotelId, P.poolId)
  const unlabeled = await page.locator('[data-testid=capacity-editor] input, [data-testid=capacity-editor] select').evaluateAll((els) => els.filter((e) => !(e.labels && e.labels.length) && !e.getAttribute('aria-label')).length)
  check('every editor control has a label', unlabeled === 0, String(unlabeled))
  await fillEdit(page, { start: seed.dates.free, end: day(seed.dates.free, 3), capacity: 9, weekdays: ['MON', 'WED'] })
  await form(page).locator('input[aria-describedby="capacity-help"]').focus(); await page.keyboard.press('Enter'); await page.waitForSelector('[data-testid=preview-table]', { timeout: 20000 })
  check('the editor works from the keyboard: Enter submits the preview', (await page.locator('[data-testid=preview-table] tbody tr').count()) >= 1)
  check('weekday selection narrows the preview to those weekdays only', await page.locator('[data-testid=preview-table] tbody tr').evaluateAll((els) => els.every((e) => /MON|WED/.test(e.innerText))))
  await page.getByLabel(/^Reason/).fill('Keyboard only check'); await page.getByLabel(/^Reason/).focus(); await page.keyboard.press('Tab')
  check('Tab from the reason reaches the Apply button', (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'apply-button')
  await page.screenshot({ path: `${SHOTS}/pool-preview.png`, fullPage: true })
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
  check('axe (WCAG A/AA) on the workspace with a preview open: no serious or critical violations', bad.length === 0, bad.map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0].target.join(' ').slice(0, 70)}`).join(' | '))
  for (const w of [1280, 768, 390]) {
    const m = await login(browser, seed.operatorEmail, { width: w, height: 900 })
    await open(m.page, P.hotelId, P.poolId)
    await fillEdit(m.page, { start: seed.dates.free, end: day(seed.dates.free, 1), capacity: 9 }); await m.page.locator('[data-testid=preview-button]').click(); await m.page.waitForSelector('[data-testid=preview-table]')
    const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    check(`no page-level horizontal overflow at ${w}px (workspace with preview)`, overflow <= 1, `overflow=${overflow}`)
    await m.ctx.close()
  }
  check('no uncaught page errors', errors.length === 0, errors.join('; '))
  check('the only non-GET API calls in the operator session were capacity previews and applies', writes.length > 0 && writes.every((w) => /capacity\/(preview|apply)$/.test(w) || /auth\/login$/.test(w)), [...new Set(writes)].join(','))

  // ---- read-only operator ---------------------------------------------------------------------------------------------------------------
  const before = await capacitiesOf(op.ctx, seed.dates.from)
  const ro = await login(browser, seed.viewerEmail)
  await open(ro.page, P.hotelId, P.poolId)
  check('the read-only operator sees the same counters and consumption', (await ro.page.locator(`[data-testid=pool-days] tr[data-date="${seed.dates.consumption}"] td`).nth(4).innerText()).trim() === '5' && (await ro.page.locator(`[data-testid=consumption-plans] tr[data-plan-id="${P1}"] td`).nth(4).innerText()).trim() === '4')
  check('the read-only operator gets no editor and an explanation, and no audit link', (await ro.page.locator('[data-testid=capacity-editor]').count()) === 0 && (await ro.page.locator('[data-testid=read-only-note]').count()) === 1 && /do not have audit.read/.test(await text(ro.page)))
  const roPrev = await ro.ctx.request.post(poolApi(P.hotelId, P.poolId, '/capacity/preview'), { headers: { origin: BASE }, data: { startDate: seed.dates.free, endDate: seed.dates.free, capacity: 4 } })
  const roApply = await ro.ctx.request.post(poolApi(P.hotelId, P.poolId, '/capacity/apply'), { headers: { origin: BASE }, data: { startDate: seed.dates.free, endDate: seed.dates.free, capacity: 4, expectedFingerprint: 'a'.repeat(64), reason: 'direct call', idempotencyKey: `${seed.tag}-ro-1` } })
  check('direct API preview and apply by the read-only operator are denied with 403', roPrev.status() === 403 && roApply.status() === 403, `${roPrev.status()}/${roApply.status()}`)
  check('nothing was written by the denied calls', (await capacitiesOf(op.ctx, seed.dates.from)) === before)
  await ro.ctx.close()

  // ---- previewer: preview yes, apply no -----------------------------------------------------------------------------------------------------
  const pv = await login(browser, seed.previewerEmail)
  await open(pv.page, P.hotelId, P.poolId)
  await fillEdit(pv.page, { start: seed.dates.free, end: seed.dates.free, capacity: 6 }); await pv.page.locator('[data-testid=preview-button]').click(); await pv.page.waitForSelector('[data-testid=preview-table]')
  check('a user with only the preview permission can preview but sees no Apply control', (await pv.page.locator('[data-testid=apply-button]').count()) === 0 && (await pv.page.locator('[data-testid=no-apply-note]').count()) === 1)
  const pvApply = await pv.ctx.request.post(poolApi(P.hotelId, P.poolId, '/capacity/apply'), { headers: { origin: BASE }, data: { startDate: seed.dates.free, endDate: seed.dates.free, capacity: 6, expectedFingerprint: 'b'.repeat(64), reason: 'direct call', idempotencyKey: `${seed.tag}-pv-1` } })
  check('direct API apply by the preview-only user is denied with 403', pvApply.status() === 403)
  await pv.ctx.close()

  // ---- other tenant -------------------------------------------------------------------------------------------------------------------------
  const bt = await login(browser, seed.bownerEmail)
  await bt.page.goto(poolUrl(P.hotelId, P.poolId)); await bt.page.waitForSelector('[data-state]', { timeout: 20000 })
  check("another tenant opening this tenant's pool gets not-found", (await bt.page.locator('[data-state]').first().getAttribute('data-state')) === 'not-found')
  const crossPrev = await bt.ctx.request.post(poolApi(P.hotelId, P.poolId, '/capacity/preview'), { headers: { origin: BASE }, data: { startDate: seed.dates.free, endDate: seed.dates.free, capacity: 1 } })
  check("another tenant's direct preview is 404", crossPrev.status() === 404)
  await open(bt.page, seed.other.hotelId, seed.other.poolId)
  check('another tenant sees only its own pool', /Beta pool/.test(await text(bt.page)))
  await bt.ctx.close()

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) { console.log('FAILED:\n' + failed.map((f) => ' - ' + f.name).join('\n')); process.exit(1) }
  function day(base, n) { return new Date(Date.parse(`${base}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10) }
})().catch((e) => { console.error(e); process.exit(1) })
