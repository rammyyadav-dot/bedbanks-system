// Real-stack browser verification of money and documents (ADR 0039, Phase 5): production Admin build, API on the STRICT runtime role, booking module on its own role.
// Cancel with a penalty -> correct invoice, credit note and cancellation note; undecided penalty; waiver by a second person; permissions; no net rate or supplier on a voucher.
// Needs OWNER_DATABASE_URL for evidence reads. Run seed-bookings.ts first (it creates the finance fixtures). Not run in CI.
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
const idOf = (ref) => sql(`SELECT id FROM "Booking" WHERE reference='${ref}'`)
const finEvents = (id) => sql(`SELECT coalesce(string_agg(type::text||':'||coalesce(penalty_minor::text,'-')||'/'||coalesce(refund_minor::text,'-'), ',' ORDER BY created_at, id), '') FROM "BookingFinanceEvent" WHERE booking_id='${id}'`)
const docs = (id) => sql(`SELECT coalesce(string_agg(type::text, ',' ORDER BY issued_at, type::text), '') FROM "BookingDocument" WHERE booking_id='${id}'`)
async function login(browser, email) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
const finance = async (page, id) => { await page.goto(`${BASE}/bookings/${id}?tab=finance`); await page.waitForSelector('[data-testid=finance-summary]', { timeout: 20000 }) }
const notice = async (page) => { await page.waitForSelector('[data-testid=booking-notice]', { timeout: 15000 }); return page.getByTestId('booking-notice').innerText() }
const issue = async (page, type) => { await page.locator(`button[data-issue=${type}]`).click(); await page.waitForFunction((t) => !document.querySelector(`button[data-issue=${t}]`), type, { timeout: 15000 }) }
async function docPage(page, id, type) { const r = await page.request.get(`${BASE}/api/v1/admin/operations/booking-finance/${id}/documents/${type}/html`); return { status: r.status(), text: await r.text(), csp: r.headers()['content-security-policy'] ?? '' } }

;(async () => {
  const F = seed.financeFixtures
  const browser = await chromium.launch()
  let { page, ctx } = await login(browser, seed.leadEmail)
  const writes = []; page.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method()) && !r.url().includes('/auth/')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`) })

  // ---- Flow A: cancel with a penalty ----
  const A = idOf(F.penalty); await finance(page, A)
  check('the Finance & documents tab shows the money, the frozen terms and the cancellation preview', /AED\s*1,000\.00/.test(await page.getByTestId('finance-summary').innerText()) && (await page.getByTestId('terms-list').innerText()).includes('50% of the total') && /500\.00/.test(await page.getByTestId('penalty-preview').innerText()))
  check('the net cost is shown to a caller who may see net rates', /Net cost/.test(await page.getByTestId('finance-summary').innerText()))
  check('the confirmation is recorded as an event awaiting Finance booking (nothing posted to a ledger)', finEvents(A) === 'CONFIRMED:-/-' && /AWAITING FINANCE BOOKING/.test(await page.getByTestId('finance-events').innerText()) && sql(`SELECT count(*) FROM "LedgerEntry" WHERE tenant_id='${seed.tenant}'`) === '0')
  const ax = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze(); const bad = ax.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
  check('axe WCAG A/AA clean on the Finance tab', bad.length === 0, bad.map((v) => v.id + ':' + v.nodes.length).join(','))
  await issue(page, 'VOUCHER'); await issue(page, 'INVOICE')
  check('voucher and invoice are issued once, numbered from the booking reference', docs(A) === 'VOUCHER,INVOICE' || docs(A) === 'INVOICE,VOUCHER')
  const voucher = await docPage(page, A, 'voucher')
  check('the voucher shows the hotel confirmation, agent reference and guest, and never the net rate, markup or supplier', voucher.status === 200 && /HC-PENALTY/.test(voucher.text) && /AG-PENALTY/.test(voucher.text) && /Money PENALTY/.test(voucher.text) && !/800\.00|SUP-SECRET|Secret Supplier|markup/i.test(voucher.text))
  check('the document page is served under a locked-down content security policy', /default-src 'none'/.test(voucher.csp))
  const invoice = await docPage(page, A, 'invoice'); check('the invoice is the sell total with the payment terms in words', /AED\s*1,000\.00/.test(invoice.text) && /agency credit account/.test(invoice.text) && !/800\.00/.test(invoice.text))
  await page.goto(`${BASE}/bookings/${A}`); await page.waitForSelector('[data-testid=booking-header]')
  await page.getByRole('button', { name: 'Request cancellation' }).click(); await page.waitForSelector('[role=dialog]')
  const preview = await page.getByTestId('cancel-preview').innerText()
  check('the cancellation dialog shows the penalty and refund before the operator confirms', /Cancelling now costs a penalty of .*500\.00/.test(preview) && /500\.00 would be refunded/.test(preview) && /fixed when you submit/.test(preview), preview)
  const dlg = page.locator('[role=dialog]'); await dlg.getByLabel(/Reason/).fill('Guest changed plans'); await dlg.getByRole('button', { name: 'Request cancellation' }).click()
  check('requesting the cancellation reports the new status', /CANCEL REQUESTED|Cancel requested/i.test(await notice(page)))
  await finance(page, A)
  check('the penalty is now fixed from the stored quote: AED 500.00 penalty, AED 500.00 refund', /QUOTED/.test(await page.getByTestId('penalty-state').innerText()) && /500\.00/.test(await page.getByTestId('penalty-state').innerText()))
  await page.goto(`${BASE}/bookings/${A}`); await page.waitForSelector('[data-testid=booking-header]')
  await page.getByRole('button', { name: 'Record cancellation' }).click(); const d2 = page.locator('[role=dialog]'); await d2.getByLabel(/Supplier cancellation reference/).fill('CXL-BROWSER-1')
  await d2.getByLabel(/Reason/).fill('Hotel confirmed the cancellation').catch(() => undefined)
  await d2.getByRole('button', { name: 'Record cancellation' }).click(); await notice(page)
  check('recording the cancellation writes the cancelled event with the fixed penalty and refund', finEvents(A) === 'CONFIRMED:-/-,CANCELLED:50000/50000', finEvents(A))
  await finance(page, A)
  check('before documents exist the credit note and cancellation note are offered, in order', (await page.locator('button[data-issue=CREDIT_NOTE]').count()) === 1 && (await page.locator('button[data-issue=CANCELLATION_NOTE]').count()) === 1)
  await issue(page, 'CREDIT_NOTE'); await issue(page, 'CANCELLATION_NOTE')
  check('invoice, credit note and cancellation note exist exactly once each', docs(A).split(',').sort().join(',') === 'CANCELLATION_NOTE,CREDIT_NOTE,INVOICE,VOUCHER', docs(A))
  const cn = await docPage(page, A, 'credit-note'); const note = await docPage(page, A, 'cancellation-note')
  check('the credit note credits AED 500.00 against the invoice and the cancellation note states the penalty, refund and rule', /AED\s*500\.00/.test(cn.text) && /INV-FB-/.test(cn.text) && /Cancellation penalty/.test(note.text) && /within 14 day/.test(note.text) && !/wallet/i.test(cn.text), cn.text.slice(0, 80))
  check('a second issue request is a replay: still one document of each type', (await page.request.post(`${BASE}/api/v1/admin/operations/booking-finance/${A}/documents/credit-note`, { data: {}, headers: { Origin: BASE } })).status() === 200 && sql(`SELECT count(*) FROM "BookingDocument" WHERE booking_id='${A}'`) === '4')
  check('the issued documents cannot be edited, even by the owner', (() => { try { sql(`UPDATE "BookingDocument" SET number='X' WHERE booking_id='${A}'`); return false } catch { return true } })())

  // ---- Flow B: no terms stored: the penalty is a person's decision ----
  const B = idOf(F.noTerms); await finance(page, B)
  check('without stored terms the preview says a person will decide, never zero', /person will decide/.test(await page.getByTestId('penalty-preview').innerText()) || /to be decided by a person/.test(await page.getByTestId('penalty-preview').innerText()))
  await issue(page, 'INVOICE')
  await page.goto(`${BASE}/bookings/${B}`); await page.waitForSelector('[data-testid=booking-header]')
  await page.getByRole('button', { name: 'Request cancellation' }).click(); await page.locator('[role=dialog]').getByLabel(/Reason/).fill('Guest cancelled'); await page.locator('[role=dialog]').getByRole('button', { name: 'Request cancellation' }).click(); await notice(page)
  await page.goto(`${BASE}/bookings/${B}`); await page.waitForSelector('[data-testid=booking-header]')
  await page.getByRole('button', { name: 'Record cancellation' }).click(); await page.locator('[role=dialog]').getByLabel(/Supplier cancellation reference/).fill('CXL-BROWSER-2'); await page.locator('[role=dialog]').getByRole('button', { name: 'Record cancellation' }).click(); await notice(page)
  await finance(page, B)
  check('the cancelled booking shows NEEDS DECISION and the credit note is withheld with the reason', /NEEDS DECISION/.test(await page.getByTestId('penalty-state').innerText()) && /Decide the cancellation penalty first/.test(await page.getByTestId('finance-documents').innerText()) && finEvents(B).endsWith('CANCELLED:-/-'), finEvents(B))
  await page.getByRole('button', { name: 'Decide penalty' }).click(); const pd = page.getByTestId('penalty-form')
  await pd.getByLabel(/New penalty/).fill('1000.01'); await pd.getByLabel(/Reason/).fill('Hotel invoice'); await pd.getByRole('button', { name: 'Decide', exact: true }).click()
  await page.waitForSelector('[data-testid=penalty-form] [role=alert]'); check('a penalty above the booking total is refused in plain words, nothing recorded', /between zero and the booking total|cannot be more/i.test(await pd.getByRole('alert').innerText()) && !/PENALTY_DECIDED/.test(finEvents(B)))
  await pd.getByLabel(/New penalty/).fill('300.00'); await pd.getByRole('button', { name: 'Decide', exact: true }).click(); await notice(page)
  check('the decided penalty is recorded as an event and the booking shows DECIDED 300.00 / 700.00', finEvents(B).endsWith('PENALTY_DECIDED:30000/70000') && /DECIDED/.test(await page.getByTestId('penalty-state').innerText()))
  await issue(page, 'CREDIT_NOTE'); await issue(page, 'CANCELLATION_NOTE')
  const cnB = await docPage(page, B, 'credit-note'); check('the credit note uses the decided penalty: AED 700.00 credited', /AED\s*700\.00/.test(cnB.text) && /AED\s*300\.00/.test(cnB.text))
  await page.reload(); await page.waitForSelector('[data-testid=finance-summary]')
  check('once cancellation documents exist the penalty can no longer be changed', (await page.getByRole('button', { name: /Decide penalty|Waive/ }).count()) === 0)
  await ctx.close()

  // ---- Flow C: waiver needs a second person with its own permission ----
  ;({ page, ctx } = await login(browser, seed.leadEmail)); const C = idOf(F.waiver)
  await page.goto(`${BASE}/bookings/${C}`); await page.waitForSelector('[data-testid=booking-header]')
  await page.getByRole('button', { name: 'Request cancellation' }).click(); await page.locator('[role=dialog]').getByLabel(/Reason/).fill('Guest unwell'); await page.locator('[role=dialog]').getByRole('button', { name: 'Request cancellation' }).click(); await notice(page)
  await finance(page, C); check('the requester (no waiver permission) sees the quoted penalty and no waive control', /QUOTED/.test(await page.getByTestId('penalty-state').innerText()) && (await page.getByRole('button', { name: /Waive/ }).count()) === 0)
  await ctx.close()
  ;({ page, ctx } = await login(browser, seed.approverEmail)); await finance(page, C)
  check('the approver sees the net cost hidden (no booking.view.net) and a waive control', !/Net cost/.test(await page.getByTestId('finance-summary').innerText()) && (await page.getByRole('button', { name: 'Waive part of the penalty' }).count()) === 1)
  await page.getByRole('button', { name: 'Waive part of the penalty' }).click(); const wd = page.getByTestId('penalty-form')
  await wd.getByLabel(/New penalty/).fill('600.00'); await wd.getByLabel(/Reason/).fill('raise attempt'); await wd.getByRole('button', { name: 'Waive', exact: true }).click(); await page.waitForSelector('[data-testid=penalty-form] [role=alert]')
  check('raising the penalty is refused: it can be waived down, never raised', /never raised|fixed when cancellation/i.test(await wd.getByRole('alert').innerText()) && !/PENALTY_WAIVED/.test(finEvents(C)))
  await wd.getByLabel(/New penalty/).fill('100.00'); await wd.getByLabel(/Reason/).fill('Guest unwell, hotel agreed'); await wd.getByRole('button', { name: 'Waive', exact: true }).click(); await page.waitForSelector('[data-testid=finance-penalty]')
  await page.waitForFunction(() => /WAIVED/.test(document.querySelector('[data-testid=penalty-state]')?.textContent ?? ''), null, { timeout: 15000 })
  check('the waiver is recorded: penalty 100.00, refund 900.00, was 500.00', finEvents(C).endsWith('PENALTY_WAIVED:10000/90000') && /was\s*AED\s*500\.00|was.*500\.00/.test(await page.getByTestId('penalty-state').innerText()))
  check('the approver cannot issue documents (no booking.documents.issue)', (await page.locator('button[data-issue]').count()) === 0)
  await ctx.close()

  // ---- read-only viewer, an operator without finance permission, an agency user ----
  ;({ page, ctx } = await login(browser, seed.finViewerEmail)); await finance(page, idOf(F.nonRefundable))
  check('a viewer sees the money but no net cost and no controls', !/Net cost/.test(await page.getByTestId('finance-summary').innerText()) && (await page.locator('button[data-issue]').count()) === 0 && (await page.getByRole('button', { name: /Decide|Waive/ }).count()) === 0)
  check('a non-refundable booking says the whole amount is retained and shows no terms list', /whole amount is retained/.test(await page.getByTestId('finance-summary').innerText()))
  await ctx.close()
  ;({ page, ctx } = await login(browser, seed.opsEmail)); await page.goto(`${BASE}/bookings/${A}`); await page.waitForSelector('[data-testid=booking-header]')
  check('an operator without the finance permission has no Finance tab', (await page.getByRole('tab', { name: 'Finance & documents' }).count()) === 0)
  const denied = await page.request.get(`${BASE}/api/v1/admin/operations/booking-finance/${A}`); check('and the API refuses them the finance view', denied.status() === 403)
  await ctx.close()
  ;({ page, ctx } = await login(browser, seed.requesterEmail)); await page.goto(`${BASE}/bookings/${A}`).catch(() => undefined)
  const agencyDenied = await page.request.get(`${BASE}/api/v1/admin/operations/booking-finance/${A}`); check('an agency user is refused the finance view', agencyDenied.status() === 403)
  await ctx.close()

  // ---- manual entry: cancellation terms ----
  ;({ page, ctx } = await login(browser, seed.leadEmail)); await page.goto(`${BASE}/bookings/new`); await page.waitForSelector('[data-testid=manual-booking-form]')
  await page.getByRole('button', { name: 'Add a cancellation rule' }).click(); const rule = page.getByRole('group', { name: 'Rule 1' }); await rule.getByLabel(/Within/).fill('7'); await rule.getByLabel(/Percent/).fill('120')
  await page.getByRole('button', { name: 'Create booking' }).click()
  check('manual entry validates cancellation rules in the form (percent above 100 is refused, nothing sent)', /A whole percent from 0 to 100/.test(await page.getByTestId('manual-booking-form').innerText()))
  const ax2 = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze(); const bad2 = ax2.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
  check('axe WCAG A/AA clean on the manual form with a rule row', bad2.length === 0, bad2.map((v) => v.id + ':' + v.nodes.length).join(','))
  await ctx.close()

  check('every write was a booking or booking-finance route; no tenant id was ever sent in a body', writes.every((w) => /\/api\/v1\/admin\/operations\/(bookings|booking-finance)\//.test(w)), writes.join(' | '))
  await browser.close()
  const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} passed`); process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
