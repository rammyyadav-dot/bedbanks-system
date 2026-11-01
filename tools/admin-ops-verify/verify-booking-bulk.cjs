// Real-stack browser verification of bulk actions on bookings (ADR 0039, Phase 6C): production Admin build, API on the STRICT runtime role, booking module on
// its own role. Needs OWNER_DATABASE_URL for evidence reads and fixtures. Run seed-bookings.ts first (the seed is consumed: re-seed before each run). Not run in CI.
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
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`) }
const sql = (q) => execFileSync('psql', [OWNER, '-Atqc', q]).toString().trim()
const userId = (email) => sql(`SELECT id FROM users WHERE email='${email}'`)
const lastOp = () => sql(`SELECT status || '|' || requested_count || '|' || succeeded_count || '|' || failed_count || '|' || action_type FROM "BookingBulkOperation" WHERE tenant_id='${seed.tenant}' ORDER BY created_at DESC LIMIT 1`)
const opCount = () => Number(sql(`SELECT count(*) FROM "BookingBulkOperation" WHERE tenant_id='${seed.tenant}'`))
const assignee = (id) => sql(`SELECT coalesce(assignee_user_id,'-') FROM "BookingOpsState" WHERE booking_id='${id}'`) || '-'
async function login(browser, email) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
const count = async (page) => {
  let last = -1
  for (let i = 0; i < 40; i++) {
    const t = await page.getByTestId('result-count').innerText().catch(() => '')
    const m = /(\d+) booking/.exec(t); const n = m ? Number(m[1]) : -2
    if (n >= 0 && n === last) return n
    last = n; await page.waitForTimeout(400)
  }
  throw new Error('the list never settled')
}
const open = async (page, qs) => { await page.goto(`${BASE}/bookings${qs}`); await page.waitForSelector('[data-testid=bookings-table]', { timeout: 20000 }); await count(page) }
const rowIds = (page) => page.getByTestId('row-select').evaluateAll((els) => els.map((e) => e.getAttribute('data-booking-id')))
const pick = async (page, ids) => { for (const id of ids) await page.locator(`[data-testid=row-select][data-booking-id="${id}"]`).check() }
const selected = (page) => page.getByTestId('bulk-selected-count').innerText().catch(() => '')
// Own fixtures (the shared seed's open cases are used up by the earlier harnesses): open cases are PENDING_SUPPLIER with no owner; settled ones are CONFIRMED with a supplier reference.
const RUN = Date.now().toString(36).toUpperCase(); const PREFIX = `FB-BK${RUN}`; let seq = 0
function makeBooking(kind) {
  seq += 1; const id = `bkbulk${RUN.toLowerCase()}${seq}`; const ref = `${PREFIX}${String(seq).padStart(2, '0')}`; const settled = kind === 'settled'
  sql(`CREATE TEMP TABLE t AS SELECT * FROM "Booking" WHERE tenant_id='${seed.tenant}' AND status='PENDING_SUPPLIER' LIMIT 1;
    UPDATE t SET id='${id}', reference='${ref}', idempotency_key='${id}', status='${settled ? 'CONFIRMED' : 'PENDING_SUPPLIER'}', supplier_ref=${settled ? `'SUP-${id}'` : 'NULL'}, hotel_confirmation_no=${settled ? `'HC-${id}'` : 'NULL'}, supplier_status=${settled ? `'CONFIRMED'` : 'NULL'}, created_at = now() - interval '${seq + 5} minutes', version=1;
    INSERT INTO "Booking" SELECT * FROM t;
    INSERT INTO "BookingEvent" (id, tenant_id, booking_id, to_status, actor_type, reason) VALUES ('${id}-e', '${seed.tenant}', '${id}', '${settled ? 'CONFIRMED' : 'PENDING_SUPPLIER'}', 'SYSTEM', 'bulk fixture');`)
  return id
}
const pool = []; const take = (n) => { if (pool.length < n) throw new Error('fixture pool exhausted'); return pool.splice(0, n) }
const LIST = `?chip=latest&pageSize=100&reference=${PREFIX}`
let settledId = ''
const confirmedId = () => settledId

;(async () => {
  const browser = await chromium.launch()
  for (let i = 0; i < 14; i++) pool.push(makeBooking('case')); settledId = makeBooking('settled')
  // ---- 1: capability gating (the API checks again) ----
  const w = await login(browser, seed.workerEmail); await open(w.page, '?status=PENDING_SUPPLIER')
  check('J1: a person with the single-booking permission but no bulk capability sees no checkboxes and no toolbar', (await w.page.getByTestId('row-select').count()) === 0 && (await w.page.getByTestId('select-page').count()) === 0 && (await w.page.getByTestId('bulk-toolbar').count()) === 0)
  const direct = await w.page.evaluate(async () => (await fetch('/api/v1/admin/operations/bookings/bulk-actions', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingIds: ['x'], action: 'ASSIGN_OWNER', payload: { assigneeUserId: null }, idempotencyKey: 'direct-attempt-1' }) })).status)
  check('J1: the same person calling the bulk API directly is refused (hiding is not the control)', direct === 403 && opCount() === 0, direct)
  await w.ctx.close()

  const { page, ctx } = await login(browser, seed.leadEmail)
  const writes = []; page.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method()) && !r.url().includes('/auth/')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`) })
  await open(page, LIST)
  const pend = (await rowIds(page)).filter((id) => id !== settledId)
  check('J2: rows have checkboxes, the toolbar is hidden until something is selected, and nothing is written by selecting', pend.length === 14 && (await page.getByTestId('bulk-toolbar').count()) === 0 && writes.length === 0, pend.length)
  await pick(page, pend.slice(0, 2))
  check('J2: the selected count is shown', /2 selected/.test(await selected(page)))
  await page.getByTestId('select-page').check()
  check('J2: select page selects every row on the page', new RegExp(`${pend.length + 1} selected`).test(await selected(page)))
  await page.getByTestId('select-page').uncheck()
  check('J2: select page again deselects the page', (await page.getByTestId('bulk-toolbar').count()) === 0)
  await pick(page, pend.slice(0, 2)); await page.getByTestId('bulk-clear').click()
  check('J2: clear selection removes the selection and the toolbar', (await page.getByTestId('bulk-toolbar').count()) === 0 && (await page.getByTestId('row-select').evaluateAll((e) => e.filter((x) => x.checked).length)) === 0)
  check('J2: selecting and clearing sent no write', writes.length === 0)

  // ---- 3: all succeed ----
  const ids3 = take(3); const opsBefore = opCount()
  await pick(page, ids3); await page.getByTestId('bulk-start-ASSIGN_OWNER').click(); await page.waitForSelector('[data-testid=bulk-confirm]')
  check('J3: the confirmation states the count and changes nothing yet', /3/.test(await page.getByTestId('bulk-confirm-count').innerText()) && opCount() === opsBefore)
  await page.waitForTimeout(700) // the dialog fades in; axe must see the settled colours
  const ax = await new AxeBuilder({ page }).include('[role=dialog]').withTags(['wcag2a', 'wcag2aa']).analyze(); const bad = ax.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
  check('J3: axe WCAG A/AA clean in the confirmation dialog', bad.length === 0, bad.map((v) => v.id + ':' + v.nodes.map((n) => n.html.slice(0, 120) + ' ' + (n.any[0]?.message ?? '')).join(' ; ')).join(','))
  await page.getByTestId('bulk-confirm-submit').click()
  check('J3: an owner is required before anything is sent', (await page.getByTestId('bulk-error').isVisible()) && opCount() === opsBefore)
  await page.getByTestId('bulk-owner').selectOption({ label: 'worker' }); await page.getByTestId('bulk-confirm-submit').click()
  await page.waitForSelector('[data-testid=bulk-result]')
  check('J3: all succeeded is worded as such, with requested, succeeded and failed counts', /All 3/.test(await page.getByTestId('bulk-result-headline').innerText()) && (await page.getByTestId('bulk-requested').innerText()) === '3' && (await page.getByTestId('bulk-succeeded').innerText()) === '3' && (await page.getByTestId('bulk-failed').innerText()) === '0')
  const ax2 = await new AxeBuilder({ page }).include('[role=dialog]').withTags(['wcag2a', 'wcag2aa']).analyze()
  check('J3: axe WCAG A/AA clean in the result summary', ax2.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).length === 0)
  const worker = userId(seed.workerEmail)
  check('J3: each booking now belongs to the person, and there is exactly one operation', ids3.every((id) => assignee(id) === worker) && lastOp() === 'SUCCEEDED|3|3|0|ASSIGN_OWNER' && opCount() === opsBefore + 1, lastOp())
  check('J3: each booking has its own event and audit through the single-booking service', Number(sql(`SELECT count(*) FROM "BookingEvent" WHERE action='opsAssigned' AND booking_id IN ('${ids3.join("','")}')`)) === 3 && Number(sql(`SELECT count(*) FROM "AuditEvent" WHERE action='booking.ops.assigned' AND entity_id IN ('${ids3.join("','")}')`)) === 3)
  await page.getByTestId('bulk-result-close').click(); await count(page)
  check('J3: after a full success the selection is empty', (await page.getByTestId('bulk-toolbar').count()) === 0)

  // ---- 4: partial success (a confirmed booking is not an open case) ----
  const conf = confirmedId(); const pend4 = take(2)
  const confRef = sql(`SELECT reference FROM "Booking" WHERE id='${conf}'`)
  await open(page, LIST); await pick(page, [...pend4, conf])
  check('J4: a mixed selection (open cases and a settled booking) is allowed; the server judges each', /3 selected/.test(await selected(page)), await selected(page))
  await page.getByTestId('bulk-start-ASSIGN_OWNER').click(); await page.getByTestId('bulk-owner').selectOption({ label: 'worker2' }); await page.getByTestId('bulk-confirm-submit').click(); await page.waitForSelector('[data-testid=bulk-result]')
  const head = await page.getByTestId('bulk-result-headline').innerText()
  check('J4: a partial result is a result summary, never a success message', /2 of 3 updated; 1 could not be/.test(head) && !/^All/.test(head) && (await page.getByTestId('bulk-result').getAttribute('data-status')) === 'PARTIAL', head)
  check('J4: the reason is shown per failed booking, in words', (await page.getByTestId('bulk-failed-table').innerText()).includes(confRef) && /current state/.test(await page.getByTestId('bulk-reasons').innerText()))
  check('J4: only the failed booking changed nothing and the others changed', assignee(conf) === '-' && pend4.every((id) => assignee(id) === userId(seed.worker2Email)) && lastOp() === 'PARTIAL|3|2|1|ASSIGN_OWNER', lastOp())
  await page.getByTestId('bulk-result-close').click(); await page.waitForTimeout(800)
  check('J4: afterwards only the failed booking stays selected, so it can be looked at', /1 selected/.test(await selected(page)), await selected(page))
  await page.getByTestId('bulk-clear').click()

  // ---- 5: stale state (the booking left the queue after it was selected) ----
  const [s1, s2] = take(2)
  await open(page, LIST); await pick(page, [s1, s2])
  sql(`UPDATE "Booking" SET status='CONFIRMED', supplier_ref='SUP-LATE-1', hotel_confirmation_no='HC-LATE-1' WHERE id='${s2}'`)
  await page.getByTestId('bulk-start-ASSIGN_OWNER').click(); await page.getByTestId('bulk-owner').selectOption({ label: 'worker' }); await page.getByTestId('bulk-confirm-submit').click(); await page.waitForSelector('[data-testid=bulk-result]')
  check('J5: a booking that changed after selection is judged as it is now: one done, one refused, none guessed', lastOp() === 'PARTIAL|2|1|1|ASSIGN_OWNER' && assignee(s1) === userId(seed.workerEmail) && assignee(s2) === '-', lastOp())
  await page.getByTestId('bulk-result-close').click(); await page.getByTestId('bulk-clear').click().catch(() => undefined)

  // ---- 6: double click and retry ----
  const [d1, d2] = take(2); const before6 = opCount(); const eventsBefore = Number(sql(`SELECT count(*) FROM "BookingEvent" WHERE action='opsAssigned'`))
  await open(page, LIST); await pick(page, [d1, d2])
  await page.getByTestId('bulk-start-ASSIGN_OWNER').click(); await page.getByTestId('bulk-owner').selectOption({ label: 'worker' })
  await page.getByTestId('bulk-confirm-submit').dblclick({ delay: 10 }).catch(() => undefined); await page.waitForSelector('[data-testid=bulk-result]')
  await page.waitForTimeout(800)
  check('J6: a double click makes exactly one operation and one effect per booking', opCount() === before6 + 1 && Number(sql(`SELECT count(*) FROM "BookingEvent" WHERE action='opsAssigned'`)) === eventsBefore + 2)
  await page.getByTestId('bulk-result-close').click()

  // ---- 7: a failed request shows an error, writes nothing, and the retry is the same request ----
  const [r1] = take(1); const before7 = opCount()
  await open(page, LIST); await pick(page, [r1])
  await page.getByTestId('bulk-start-ASSIGN_OWNER').click(); await page.getByTestId('bulk-owner').selectOption({ label: 'worker' })
  let bodies = []; await page.route('**/bookings/bulk-actions', (route) => { bodies.push(route.request().postData()); route.abort() })
  await page.getByTestId('bulk-confirm-submit').click(); await page.waitForSelector('[data-testid=bulk-error]')
  check('J7: a network failure is an error in the dialog (not a result, not a success) and nothing was written', (await page.getByTestId('bulk-result').count()) === 0 && opCount() === before7 && assignee(r1) === '-')
  await page.unroute('**/bookings/bulk-actions'); await page.getByTestId('bulk-confirm-submit').click(); await page.waitForSelector('[data-testid=bulk-result]')
  check('J7: the retry succeeds once, and the request carried no tenant or user id', opCount() === before7 + 1 && assignee(r1) === userId(seed.workerEmail) && bodies.every((b) => !/"(tenantId|tenant_id|userId|requestedBy\w*)"/i.test(b ?? '')), bodies[0])
  await page.getByTestId('bulk-result-close').click()

  // ---- 8: acknowledge ----
  const [a1, a2] = take(2); const lead = userId(seed.leadEmail)
  await open(page, LIST); await pick(page, [a1, a2])
  await page.getByTestId('bulk-start-ASSIGN_OWNER').click(); await page.getByTestId('bulk-owner').selectOption({ label: 'lead' }); await page.getByTestId('bulk-confirm-submit').click(); await page.waitForSelector('[data-testid=bulk-result]'); await page.getByTestId('bulk-result-close').click()
  await open(page, LIST); await pick(page, [a1, a2])
  await page.getByTestId('bulk-start-ACKNOWLEDGE').click(); await page.waitForSelector('[data-testid=bulk-confirm]')
  check('J8: acknowledge asks for no owner', (await page.getByTestId('bulk-owner').count()) === 0)
  await page.getByTestId('bulk-confirm-submit').click(); await page.waitForSelector('[data-testid=bulk-result]')
  check('J8: bulk acknowledge acknowledges each of the person’s own cases', lastOp() === 'SUCCEEDED|2|2|0|ACKNOWLEDGE' && Number(sql(`SELECT count(*) FROM "BookingEvent" WHERE action='opsAcknowledged' AND booking_id IN ('${a1}','${a2}')`)) === 2, lastOp())
  check('J8: the browser sent only POSTs to the bulk route (no mass update, no per-booking shortcut)', writes.every((x) => x === 'POST /api/v1/admin/operations/bookings/bulk-actions'), [...new Set(writes)].join(','))
  await ctx.close(); await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`); process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
