// Real-stack browser acceptance of the booking operations queue (ADR 0039, Phase 4): production Admin build, API on the STRICT runtime role, booking module on its own role,
// runner on, mock supplier allowed for the seeded tenant only, ADMIN_BOOKING_OPS_ENABLED=true. Needs OWNER_DATABASE_URL for evidence reads. Not run in CI. See README.md.
const path = require('path')
const { execFileSync } = require('child_process')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const AxeBuilder = req('@axe-core/playwright').default || req('@axe-core/playwright')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-bookings.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const OWNER = process.env.OWNER_DATABASE_URL
const F = seed.opsFixtures
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 200) : ''}`) }
const sql = (q) => execFileSync('psql', [OWNER, '-Atqc', q]).toString().trim()
const idOf = (ref) => sql(`SELECT id FROM "Booking" WHERE reference='${ref}'`)
const st = (ref) => sql(`SELECT status||'|'||coalesce(supplier_status,'')||'|'||coalesce(supplier_ref,'') FROM "Booking" WHERE reference='${ref}'`)
const until = async (fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 500)) } return false }
async function login(browser, email) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
const queue = async (page, qs = '') => { await page.goto(`${BASE}/bookings/queue${qs}`); await page.waitForSelector('[data-testid=queue-table], [data-state=empty], [data-state]', { timeout: 20000 }) }
const row = (page, ref) => page.locator(`[data-testid=queue-row][data-reference="${ref}"]`)
const detail = async (page, ref) => { await page.goto(`${BASE}/bookings/${idOf(ref)}?tab=operations`); await page.waitForSelector('[data-testid=operations-panel]', { timeout: 20000 }) }
const buttons = (page, sel) => page.locator(`${sel} button`).allInnerTexts()

;(async () => {
  const browser = await chromium.launch()
  let { page, ctx } = await login(browser, seed.leadEmail)
  const writes = []; page.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method()) && !r.url().includes('/auth/')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`) })

  // ---- the queue itself ----
  await queue(page, '?pageSize=100')
  check('the Operations queue opens with its views and counts', (await page.locator('[data-tab]').count()) === 9 && /\(\d+\)/.test(await page.getByTestId('count-active').innerText()))
  check('opening and reading the queue sends no write', writes.length === 0, writes.join(' | '))
  const ranks = await page.locator('[data-testid=queue-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-priority')))
  const rk = { CRITICAL: 3, URGENT: 2, HIGH: 1, NORMAL: 0 }
  check('the order is the queue’s: priority never goes up as you read down', ranks.length > 5 && ranks.every((p, i) => i === 0 || rk[ranks[i - 1]] >= rk[p]), ranks.slice(0, 12).join(','))
  const axq = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze(); const badq = axq.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
  check('axe WCAG A/AA clean on the queue', badq.length === 0, badq.map((v) => v.id + ':' + v.nodes.length).join(','))
  check('the SLA targets in force are stated on the page', /Pending supplier 30/.test(await page.getByTestId('sla-policy').innerText()))

  // ---- Flow D: SLA breach ----
  const breached = row(page, F.breached); const fresh = row(page, F.fresh)
  check('FLOW D: the breached fixture is shown as SLA breached and overdue', (await breached.getAttribute('data-sla')) === 'BREACHED' && /overdue by/.test(await breached.innerText()), (await breached.innerText()).replace(/\n/g, ' ').slice(0, 120))
  check('FLOW D: it is prioritised above the fresh one', (await page.locator('[data-testid=queue-row]').evaluateAll((els, [a, b]) => els.findIndex((e) => e.getAttribute('data-reference') === a) < els.findIndex((e) => e.getAttribute('data-reference') === b), [F.breached, F.fresh])))
  check('FLOW D: the fresh one is within SLA', (await fresh.getAttribute('data-sla')) === 'WITHIN_SLA')
  await page.locator('[data-tab=breached]').click(); await page.waitForTimeout(800)
  check('FLOW D: the SLA breached view lists it and not the fresh one', (await row(page, F.breached).count()) === 1 && (await row(page, F.fresh).count()) === 0)
  await detail(page, F.breached)
  check('FLOW D: the detail shows the overdue duration', /overdue by/.test(await page.getByTestId('ops-remaining').innerText()), await page.getByTestId('ops-remaining').innerText())

  // ---- Flow A: unknown supplier answer ----
  await queue(page, '?tab=unknown&pageSize=100')
  const ur = row(page, F.unknown)
  const utext = await ur.innerText()
  check('FLOW A: the booking is marked “Supplier answer unknown” and “state uncertain”, and its booking status is still Pending, not Failed', /Supplier answer unknown/.test(utext) && /UNCERTAIN/.test(utext) && /PENDING SUPPLIER/i.test(utext) && !/FAILED/.test(utext), utext.replace(/\n/g, ' ').slice(0, 160))
  check('FLOW A: the priority reflects the risk (Urgent or Critical)', ['URGENT', 'CRITICAL'].includes(await ur.getAttribute('data-priority')), await ur.getAttribute('data-priority'))
  check('FLOW A: the next safe step is a sync, never a send', /Sync with supplier/.test(utext) && !/Send to supplier/.test(utext))
  await detail(page, F.unknown)
  check('FLOW A: the detail explains the duplicate-booking risk', /may already hold this booking/.test(await page.getByTestId('ops-unknown').innerText()) && /must not be sent again/.test(await page.getByTestId('ops-unknown').innerText()))
  const supplierButtons = await page.locator('[data-supplier-op]').allInnerTexts()
  check('FLOW A: Sync with supplier is offered; Send and Retry are not', supplierButtons.join('|') === 'Sync with supplier' && (await page.getByTestId('ops-send-withheld').isVisible()), supplierButtons.join('|'))
  const axp = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze(); const badp = axp.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
  check('axe WCAG A/AA clean on the Operations panel', badp.length === 0, badp.map((v) => v.id + ':' + v.nodes.length).join(','))
  await page.locator('[data-action=answer]').click(); await page.waitForSelector('[data-testid=ops-dialog]')
  const options = await page.locator('[data-testid=ops-dialog] select option').allInnerTexts()
  check('FLOW A: the manual resolution offers named answers only: there is no generic “failed” or status picker', options.some((o) => /no booking exists/.test(o)) && options.some((o) => /rejected the booking/.test(o)) && !options.some((o) => /^failed$/i.test(o.trim())) && !options.some((o) => /status/i.test(o)), options.join(' | '))
  await page.locator('[data-testid=ops-dialog] select').selectOption({ label: 'Supplier confirms no booking exists' })
  check('FLOW A: its help says it does not mean rejected', /does not change/.test(await page.getByTestId('answer-help').innerText()))
  const submit = page.locator('[data-testid=ops-dialog] button[type=submit]')
  check('FLOW A: it cannot be submitted without evidence and a reason', await submit.isDisabled())
  await page.getByLabel(/Who at the supplier/).fill('Agent Sam, ticket 4242'); await page.locator('[data-testid=ops-dialog] textarea').fill('Called reservations desk, they hold nothing under our reference')
  check('FLOW A: with evidence and a reason it can be submitted', await submit.isEnabled())
  await submit.click(); await page.waitForSelector('[data-testid=booking-notice]', { timeout: 15000 })
  check('FLOW A: the booking is still Pending (not failed, not confirmed) and the supplier now holds nothing', st(F.unknown).startsWith('PENDING_SUPPLIER|NOT_FOUND'), st(F.unknown))
  await page.reload(); await page.waitForSelector('[data-testid=operations-panel]')
  check('FLOW A: only now is “Send to supplier” offered', (await page.locator('[data-supplier-op=send]').count()) === 1)
  await page.locator('[data-supplier-op=send]').click()
  check('FLOW A: sending queues one booking request and the supplier confirms it once', await until(() => st(F.unknown).startsWith('CONFIRMED|CONFIRMED|MOCK-')) && sql(`SELECT count(*) FROM "BookingSupplierCall" WHERE booking_id='${idOf(F.unknown)}' AND action='BOOK'`) === '1', st(F.unknown))
  await page.getByRole('button', { name: 'Refresh' }).click(); await page.waitForTimeout(800)
  await queue(page, '?tab=resolved&pageSize=100'); check('FLOW A: the resolved case appears under Resolved / recent and has left the active queue', (await row(page, F.unknown).count()) === 1 && (await (async () => { await queue(page, '?pageSize=100'); return row(page, F.unknown).count() })()) === 0)

  // ---- Flow B: cancellation failed ----
  await queue(page, '?tab=cancellation&pageSize=100')
  const cr = row(page, F.cancelFailed)
  check('FLOW B: the refused cancellation is Urgent (or higher) and still Cancel requested', ['URGENT', 'CRITICAL'].includes(await cr.getAttribute('data-priority')) && /CANCEL REQUESTED/i.test(await cr.innerText()) && /Cancellation not confirmed by supplier/.test(await cr.innerText()), (await cr.innerText()).replace(/\n/g, ' ').slice(0, 140))
  await detail(page, F.cancelFailed)
  check('FLOW B: the detail says “Urgent — supplier cancellation not confirmed”', /Urgent — supplier cancellation not confirmed/.test(await page.getByTestId('ops-cancel-failed').innerText()))
  check('FLOW B: the timeline records the supplier’s refusal', /Cancellation refused by the supplier/.test(await page.getByTestId('ops-timeline').innerText()))
  await page.reload(); await page.waitForSelector('[data-testid=operations-panel]'); await queue(page, '?tab=cancellation&pageSize=100')
  check('FLOW B: the case is still active after a reload', (await row(page, F.cancelFailed).count()) === 1 && st(F.cancelFailed).startsWith('CANCEL_REQUESTED|CANCEL_FAILED'))
  await ctx.close()

  // ---- Flow C: assignment ----
  ;({ page, ctx } = await login(browser, seed.workerEmail))
  await queue(page, '?tab=active&pageSize=100')
  await row(page, F.fresh).locator('[data-action=claim]').click(); await page.waitForSelector('[data-testid=queue-notice]', { timeout: 15000 })
  await queue(page, '?tab=mine')
  check('FLOW C: the operator claims the case and it appears in My queue', (await row(page, F.fresh).count()) === 1 && /\(you\)/.test(await row(page, F.fresh).getByTestId('owner').innerText()))
  await queue(page, '?tab=unassigned&pageSize=100'); check('FLOW C: it has left Unassigned', (await row(page, F.fresh).count()) === 0)
  await ctx.close()
  ;({ page, ctx } = await login(browser, seed.worker2Email)); await queue(page, '?tab=active&pageSize=100')
  check('FLOW C: another operator sees who owns it', /worker/.test(await row(page, F.fresh).getByTestId('owner').innerText()) && !/\(you\)/.test(await row(page, F.fresh).getByTestId('owner').innerText()))
  await queue(page, '?tab=mine'); check('FLOW C: and it is not in their My queue', (await row(page, F.fresh).count()) === 0)
  await detail(page, F.fresh)
  check('FLOW C: the timeline shows the assignment', /Assigned/.test(await page.getByTestId('ops-timeline').innerText()))
  check('FLOW C: the claim is in the audit log', sql(`SELECT count(*) FROM "AuditEvent" WHERE entity_id='${idOf(F.fresh)}' AND action='booking.ops.assigned'`) === '1')
  await page.locator('[data-action=claim]').click(); await page.waitForSelector('[data-testid=booking-notice]', { timeout: 15000 })
  check('FLOW C: taking over is explicit and recorded', sql(`SELECT count(*) FROM "AuditEvent" WHERE entity_id='${idOf(F.fresh)}' AND action='booking.ops.assigned'`) === '2')
  await ctx.close()

  // ---- permissions ----
  ;({ page, ctx } = await login(browser, seed.opsViewerEmail)); await queue(page, '?tab=active&pageSize=100')
  check('a viewer sees the queue but no Claim buttons', (await page.locator('[data-testid=queue-row]').count()) > 0 && (await page.locator('[data-action=claim]').count()) === 0)
  await detail(page, F.cancelFailed)
  check('a viewer sees the Operations panel with no actions', (await page.locator('[data-testid=operations-panel] [data-action]').count()) === 0 && (await page.locator('[data-supplier-op]').count()) === 0)
  await ctx.close()
  ;({ page, ctx } = await login(browser, seed.opsEmail)); await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-testid=bookings-table]')
  check('a user without booking.ops.view has no queue link', (await page.getByTestId('open-ops-queue').count()) === 0)
  await page.goto(`${BASE}/bookings/queue`); await page.waitForTimeout(2000)
  check('and the queue answers with an explicit refusal, not an empty list', (await page.locator('[data-testid=queue-row]').count()) === 0 && /permission|not allowed|forbidden|access/i.test(await page.locator('main').innerText()), (await page.locator('main').innerText()).replace(/\n/g, ' ').slice(-140))
  await ctx.close(); await browser.close()
  const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} passed`); process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
