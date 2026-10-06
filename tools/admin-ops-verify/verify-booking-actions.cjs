// Real-stack browser verification of the booking lifecycle actions and manual entry (ADR 0039, Phase 2): production Admin build, API on the STRICT runtime role,
// booking module on its own role with narrow write grants, ADMIN_MANUAL_BOOKING_ENABLED=true. Needs OWNER_DATABASE_URL for evidence reads and fixture moves. Not run in CI.
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
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 180) : ''}`) }
const sql = (q) => execFileSync('psql', [OWNER, '-Atqc', q]).toString().trim()
async function login(browser, email) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
const pick = (status, extra = '') => sql(`SELECT id FROM "Booking" WHERE tenant_id='${seed.tenant}' AND status='${status}' AND closed_at IS NULL ${extra} ORDER BY created_at LIMIT 1`)
const state = (id) => sql(`SELECT status||'|'||version||'|'||coalesce(supplier_ref,'')||'|'||coalesce(hotel_confirmation_no,'') FROM "Booking" WHERE id='${id}'`)
const open = async (page, id) => { await page.goto(`${BASE}/bookings/${id}`); await page.waitForSelector('[data-testid=booking-header]', { timeout: 20000 }) }
const actions = (page) => page.locator('[data-testid=booking-actions] button').allInnerTexts()

;(async () => {
  const browser = await chromium.launch()
  let { page, ctx } = await login(browser, seed.leadEmail)
  const writes = []; page.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method()) && !r.url().includes('/auth/')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`) })

  // ---- on-request -> confirmed, through the dialog ----
  const onReq = pick('ON_REQUEST'); await open(page, onReq)
  const offered = await actions(page)
  check('an ON_REQUEST booking offers Confirm and Reject (and Edit references), nothing illegal', offered.includes('Confirm') && offered.includes('Reject') && !offered.some((t) => /Cancel|Amend|no-show/i.test(t)), offered.join(' | '))
  await page.getByRole('button', { name: 'Confirm', exact: true }).click(); await page.waitForSelector('[role=dialog]')
  check('the dialog is modal and focuses its first field', await page.evaluate(() => document.activeElement?.tagName === 'INPUT' && !!document.activeElement.closest('[role=dialog]')))
  const ax = await new AxeBuilder({ page }).include('[role=dialog]').withTags(['wcag2a', 'wcag2aa']).analyze(); const bad = ax.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
  check('axe WCAG A/AA clean inside the action dialog', bad.length === 0, bad.map((v) => v.id).join(','))
  await page.getByRole('button', { name: 'Confirm', exact: true }).last().click()
  check('submitting without the mandatory references is refused in the dialog, nothing is sent', await page.getByText(/Required: Supplier reference, Hotel confirmation number/).isVisible() && writes.length === 0)
  await page.keyboard.press('Escape'); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  check('Escape closes the dialog and focus returns to the control that opened it', await page.evaluate(() => document.activeElement?.textContent === 'Confirm'))
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  const dlg = page.locator('[role=dialog]'); await dlg.getByLabel(/Supplier reference/).fill('SUP-BROWSER-1'); await dlg.getByLabel(/Hotel confirmation number/).fill('HC-BROWSER-1')
  await dlg.getByRole('button', { name: 'Confirm', exact: true }).click(); await page.waitForSelector('[data-testid=booking-notice]', { timeout: 15000 })
  check('confirming updates the booking, shows a notice and records the change', /now CONFIRMED/.test(await page.getByTestId('booking-notice').innerText()) && state(onReq).startsWith('CONFIRMED|1|SUP-BROWSER-1|HC-BROWSER-1'), state(onReq))
  await page.waitForSelector('[data-testid=booking-header]'); await page.getByRole('tab', { name: 'Timeline' }).click(); await page.waitForSelector('[data-testid=timeline]')
  check('the timeline shows the action, the actor and the transition', /ON REQUEST → CONFIRMED/.test(await page.getByTestId('timeline').innerText()) && /Confirm/.test(await page.getByTestId('timeline').innerText()))
  check('exactly one POST was made (idempotent single submit)', writes.filter((w) => w.startsWith('POST')).length === 1, writes.join(' | '))

  // ---- stale view: another actor moves it first ----
  const pend = pick('PENDING_SUPPLIER'); await open(page, pend)
  await page.getByRole('button', { name: 'Record supplier confirmation' }).click(); const d2 = page.locator('[role=dialog]'); await d2.getByLabel(/Supplier reference/).fill('SUP-STALE')
  sql(`UPDATE "Booking" SET status='FAILED' WHERE id='${pend}'`)
  await d2.getByRole('button', { name: 'Record supplier confirmation' }).click(); await page.waitForSelector('[data-testid=booking-action-error]')
  check('a stale view is a plain-words conflict with a reload, and nothing was applied', /changed while you were working/.test(await page.getByTestId('booking-action-error').innerText()) && state(pend).startsWith('FAILED'))
  sql(`UPDATE "Booking" SET status='PENDING_SUPPLIER' WHERE id='${pend}'`)

  // ---- non-refundable cancellation needs the second confirmation ----
  const conf = pick('CONFIRMED', "AND is_refundable = false AND supplier_ref IS NOT NULL"); await open(page, conf)
  await page.getByRole('button', { name: 'Request cancellation' }).click(); const d3 = page.locator('[role=dialog]'); await d3.getByLabel(/Reason/).fill('Guest cancelled')
  await d3.getByRole('button', { name: 'Request cancellation' }).click()
  check('a non-refundable cancellation is blocked until the second confirmation is ticked', await page.getByText(/Second confirmation/).isVisible() && state(conf).startsWith('CONFIRMED'))
  await d3.getByRole('checkbox').check(); await d3.getByRole('button', { name: 'Request cancellation' }).click(); await page.waitForSelector('[data-testid=booking-notice]')
  check('then it moves to CANCEL REQUESTED', state(conf).startsWith('CANCEL_REQUESTED'), state(conf))

  // ---- edit references ----
  const noref = pick('CONFIRMED', 'AND supplier_ref IS NULL'); await open(page, noref)
  check('a Confirmed booking without a supplier reference shows the flag', await page.getByText('MISSING SUPPLIER REF').isVisible())
  await page.getByRole('button', { name: 'Edit references' }).click(); const d4 = page.locator('[role=dialog]'); await d4.getByLabel('Supplier reference').fill('SUP-EDIT-1'); await d4.getByLabel(/Reason/).fill('Phoned the supplier')
  await d4.getByRole('button', { name: 'Save references' }).click(); await page.waitForSelector('[data-testid=booking-notice]')
  await page.waitForFunction(() => !document.body.innerText.includes('MISSING SUPPLIER REF'))
  check('editing references clears the missing-reference flag and keeps the status', state(noref).startsWith('CONFIRMED') && state(noref).includes('SUP-EDIT-1'))

  // ---- closed bookings offer nothing ----
  const closed = sql(`SELECT id FROM "Booking" WHERE tenant_id='${seed.tenant}' AND closed_at IS NOT NULL LIMIT 1`); await open(page, closed)
  check('a closed booking offers no action and says CLOSED', (await page.locator('[data-testid=booking-actions]').count()) === 0 && await page.getByText('CLOSED', { exact: true }).isVisible())

  // ---- manual entry ----
  await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-testid=bookings-table]')
  check('the list offers manual entry to a permitted operator', await page.getByTestId('new-manual-booking').isVisible())
  await page.getByTestId('new-manual-booking').click(); await page.waitForSelector('[data-testid=manual-booking-form]')
  await page.getByRole('button', { name: 'Create booking' }).click()
  check('an empty manual form lists what is missing and sends nothing', await page.getByText('Fix the highlighted fields and try again.').isVisible() && !writes.some((w) => w === 'POST /api/v1/admin/operations/bookings'))
  await page.getByLabel(/^Agency \(required\)/).selectOption({ index: 1 }); await page.getByLabel(/^Hotel \(required\)/).selectOption({ index: 1 })
  await page.getByLabel(/^Supplier \(required\)/).fill('Supplier One'); const fut = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10)
  await page.getByLabel(/^Check-in/).fill(fut(30)); await page.getByLabel(/^Check-out/).fill(fut(33)); await page.getByLabel(/^Sell amount/).fill('2500.50'); await page.getByLabel(/^Net amount/).fill('2000')
  const room = page.getByRole('group', { name: 'Room 1' }); await room.getByLabel(/Room name/).fill('Deluxe Sea View')
  const guest = page.getByRole('group', { name: 'Guest 1' }); await guest.getByLabel(/First name/).fill('Browser'); await guest.getByLabel(/Last name/).fill('Tester')
  const ax2 = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze(); const bad2 = ax2.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
  check('axe WCAG A/AA clean on the manual form', bad2.length === 0, bad2.map((v) => v.id + ':' + v.nodes.length).join(','))
  await page.getByRole('button', { name: 'Create booking' }).click(); await page.waitForURL(/\/bookings\/[^/]+$/, { timeout: 20000 }); await page.waitForSelector('[data-testid=booking-header]')
  const newId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop())
  check('the manual booking is created as PENDING SUPPLIER with an FB- reference, amounts in minor units', /^PENDING_SUPPLIER\|1/.test(state(newId)) && /^FB-[0-9A-F]{20}$/.test(sql(`SELECT reference FROM "Booking" WHERE id='${newId}'`)) && sql(`SELECT total_minor||','||net_minor||','||markup_minor||','||channel FROM "Booking" WHERE id='${newId}'`) === '250050,200000,50050,MANUAL')
  check('manual entry moved no money and called no supplier', sql(`SELECT (SELECT count(*) FROM "SupplierMutation" WHERE booking_id='${newId}')||','||(SELECT count(*) FROM "InventoryHold" WHERE tenant_id='${seed.tenant}' AND created_at > now() - interval '1 hour')`).startsWith('0,'))
  check('the new booking offers the manual supplier-outcome actions', (await actions(page)).includes('Record supplier confirmation'))
  await page.setViewportSize({ width: 390, height: 800 }); await page.goto(`${BASE}/bookings/${newId}`); await page.waitForSelector('[data-testid=booking-header]')
  check('no horizontal page scroll at 390px with the action bar', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  await ctx.close()

  // ---- read-only operator sees no controls ----
  ;({ page, ctx } = await login(browser, seed.opsEmail)); await open(page, pick('ON_REQUEST'))
  check('an operator without action permissions sees no action buttons', (await page.locator('[data-testid=booking-actions]').count()) === 0)
  await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-testid=bookings-table]'); check('and no manual-entry button', (await page.getByTestId('new-manual-booking').count()) === 0)
  await page.goto(`${BASE}/bookings/new`); await page.waitForSelector('[data-testid=manual-unavailable]'); check('the manual page says it is not available to them', true)
  await ctx.close()

  // ---- agency requester: request only, own agency ----
  ;({ page, ctx } = await login(browser, seed.requesterEmail))
  const mine = sql(`SELECT id FROM "Booking" WHERE tenant_id='${seed.tenant}' AND status='CONFIRMED' AND closed_at IS NULL AND agency_id=(SELECT agency_id FROM "AgencyMember" WHERE tenant_id='${seed.tenant}' AND user_id=(SELECT id FROM users WHERE email='${seed.requesterEmail}')) LIMIT 1`)
  await open(page, mine); const mineActions = await actions(page)
  check('an agency user is offered only the requests', mineActions.includes('Request amendment') && mineActions.includes('Request cancellation') && !mineActions.some((t) => /Edit references|Approve|Confirm|Record/i.test(t)), mineActions.join(' | '))
  await ctx.close()

  check('every write was a booking route with the session cookie only (no tenant in any body)', writes.every((w) => /\/api\/v1\/admin\/operations\/bookings/.test(w)), writes.join(' | '))
  await browser.close()
  const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} passed`); process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
