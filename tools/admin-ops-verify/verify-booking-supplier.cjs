// Real-stack browser verification of the supplier queue (ADR 0039, Phase 3): production Admin build, API on the STRICT runtime role, booking module on its own role,
// the job runner ENABLED, and the mock supplier allowed for the seeded tenant only. Needs OWNER_DATABASE_URL for evidence reads. Not run in CI. See README.md.
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
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 200) : ''}`) }
const sql = (q) => execFileSync('psql', [OWNER, '-Atqc', q]).toString().trim()
const fut = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10)
async function login(browser, email) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
/** Enters a manual booking through the real form and returns its id (or the error text when the API refuses). */
async function enter(page, supplier, send) {
  await page.goto(`${BASE}/bookings/new`); await page.waitForSelector('[data-testid=manual-booking-form]')
  await page.getByLabel(/^Agency \(required\)/).selectOption({ index: 1 }); await page.getByLabel(/^Hotel \(required\)/).selectOption({ index: 1 })
  await page.getByLabel(/^Supplier \(required\)/).fill(supplier); await page.getByLabel(/^Check-in/).fill(fut(30)); await page.getByLabel(/^Check-out/).fill(fut(33)); await page.getByLabel(/^Sell amount/).fill('1800.00')
  await page.getByRole('group', { name: 'Room 1' }).getByLabel(/Room name/).fill('Deluxe'); const g = page.getByRole('group', { name: 'Guest 1' }); await g.getByLabel(/First name/).fill('Sup'); await g.getByLabel(/Last name/).fill('Plier')
  if (send) await page.getByLabel(/Send to the supplier now/).check()
  await page.getByRole('button', { name: 'Create booking' }).click()
  const outcome = await Promise.race([page.waitForURL((u) => /^\/bookings\/(?!new$)[^/]+$/.test(u.pathname), { timeout: 20000 }).then(() => 'ok'), page.waitForSelector('[data-testid=manual-error]', { timeout: 20000 }).then(() => 'error')])
  if (outcome === 'error') return { error: await page.getByTestId('manual-error').innerText() }
  await page.waitForSelector('[data-testid=booking-header]'); return { id: decodeURIComponent(new URL(page.url()).pathname.split('/').pop()) }
}
const status = (id) => sql(`SELECT status||'|'||coalesce(supplier_status,'')||'|'||coalesce(supplier_ref,'') FROM "Booking" WHERE id='${id}'`)
const until = async (fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 500)) } return false }
const tab = async (page, name) => { await page.getByRole('tab', { name }).click(); await page.waitForSelector('[data-testid=supplier-panel]') }

;(async () => {
  const browser = await chromium.launch()
  let { page, ctx } = await login(browser, seed.leadEmail)

  const ok = await enter(page, 'mock-confirm', true)
  check('manual entry offers "Send to the supplier now" and creates the booking queued', ok.id && /^PENDING_SUPPLIER|^CONFIRMED/.test(status(ok.id)), status(ok.id))
  check('the queue runs outside the request and the supplier confirms it', await until(() => status(ok.id).startsWith('CONFIRMED|CONFIRMED|MOCK-')), status(ok.id))
  await page.reload(); await page.waitForSelector('[data-testid=booking-header]'); await tab(page, 'Supplier')
  const panel = await page.getByTestId('supplier-panel').innerText()
  check('the Supplier tab shows the job, the call summary and the supplier’s answer', /SUCCEEDED/.test(panel) && /CONFIRMED/.test(panel) && /book/.test(panel) && /never stored/.test(panel), panel.slice(0, 120).replace(/\n/g, ' '))
  const ax = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze(); const bad = ax.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
  check('axe WCAG A/AA clean on the Supplier tab', bad.length === 0, bad.map((v) => v.id + ':' + v.nodes.length).join(','))

  const ghost = await enter(page, 'mock-ghost', true)
  check('NO GHOST: a timed-out call is settled from the supplier’s own answer, not failed', await until(() => status(ghost.id).startsWith('CONFIRMED|CONFIRMED|MOCK-')), status(ghost.id))
  check('and exactly one booking call was made', sql(`SELECT count(*) FROM "BookingSupplierCall" WHERE booking_id='${ghost.id}' AND action='BOOK'`) === '1' && sql(`SELECT count(*) FROM "BookingSupplierCall" WHERE booking_id='${ghost.id}' AND action='STATUS_CHECK'`) === '1')
  await page.reload(); await page.waitForSelector('[data-testid=booking-header]'); await tab(page, 'Supplier')
  const ghostPanel = await page.getByTestId('supplier-panel').innerText(); check('the call log shows the timeout and the status check that found it', /TIMEOUT/.test(ghostPanel) && /FOUND CONFIRMED/.test(ghostPanel))

  const down = await enter(page, 'mock-down', true)
  check('an unreachable supplier leaves the booking Pending supplier with an UNKNOWN answer, never Failed', await until(() => status(down.id).startsWith('PENDING_SUPPLIER|UNKNOWN')), status(down.id))
  await page.reload(); await page.waitForSelector('[data-testid=booking-header]')
  check('the header says the answer is unknown', await page.getByText('SUPPLIER ANSWER UNKNOWN').isVisible())
  await tab(page, 'Supplier')
  check('the screen explains it and offers only Sync, not Send again', await page.getByTestId('supplier-unknown').isVisible() && (await page.locator('[data-testid=supplier-panel] [data-op]').allInnerTexts()).join('|') === 'Sync with supplier')
  await page.locator('[data-op=sync]').click(); await until(() => sql(`SELECT count(*) FROM "BookingSupplierJob" WHERE booking_id='${down.id}'`) === '2', 15000)
  check('Sync queues a status check, and the booking is still not failed', status(down.id).startsWith('PENDING_SUPPLIER'))

  const flaky = await enter(page, 'mock-flaky', true)
  check('a flaky supplier waits for its retry', await until(() => sql(`SELECT status FROM "BookingSupplierJob" WHERE booking_id='${flaky.id}'`) === 'RETRY_WAIT'), sql(`SELECT status FROM "BookingSupplierJob" WHERE booking_id='${flaky.id}'`))
  await page.reload(); await page.waitForSelector('[data-testid=booking-header]'); await tab(page, 'Supplier')
  check('the next try is shown with its attempt count', /1 of 4/.test(await page.getByTestId('supplier-panel').innerText()))
  await page.locator('[data-op=retryNow]').click()
  check('Retry now from the detail page runs it and it confirms', await until(() => status(flaky.id).startsWith('CONFIRMED|CONFIRMED|MOCK-')), status(flaky.id))

  const none = await enter(page, 'Acme Hotels', true)
  check('a supplier with no connection is refused honestly and nothing is created', /No supplier connection|no supplier adapter/i.test(none.error ?? '') && sql(`SELECT count(*) FROM "Booking" WHERE tenant_id='${seed.tenant}' AND supplier='Acme Hotels'`) === '0', none.error)
  const plain = await enter(page, 'Acme Hotels', false); await tab(page, 'Supplier')
  check('without a connection the Supplier tab says so and offers nothing to send', /No supplier connection is set up/.test(await page.getByTestId('supplier-panel').innerText()) && (await page.locator('[data-testid=supplier-panel] [data-op]').count()) === 0)
  await ctx.close()

  ;({ page, ctx } = await login(browser, seed.opsEmail)); await page.goto(`${BASE}/bookings/${ok.id}`); await page.waitForSelector('[data-testid=booking-header]'); await tab(page, 'Supplier')
  check('an operator without the supplier permission sees the queue but no buttons', (await page.locator('[data-testid=supplier-panel] [data-op]').count()) === 0 && /switched off|not use it|needs the supplier retry/.test(await page.getByTestId('supplier-panel').innerText()))
  await ctx.close()
  ;({ page, ctx } = await login(browser, seed.requesterEmail))
  const mine = sql(`SELECT id FROM "Booking" WHERE tenant_id='${seed.tenant}' AND agency_id=(SELECT agency_id FROM "AgencyMember" WHERE tenant_id='${seed.tenant}' AND user_id=(SELECT id FROM users WHERE email='${seed.requesterEmail}')) LIMIT 1`)
  await page.goto(`${BASE}/bookings/${mine}`); await page.waitForSelector('[data-testid=booking-header]')
  check('an agency user never sees a Supplier tab', (await page.getByRole('tab', { name: 'Supplier' }).count()) === 0)
  await ctx.close(); await browser.close()
  const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} passed`); process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
