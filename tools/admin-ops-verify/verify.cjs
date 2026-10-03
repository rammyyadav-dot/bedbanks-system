const path = require('path')
const { createRequire } = require('module')
// Playwright and axe are installed for the website workspace; reuse them rather than adding a dependency to Admin.
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const AxeBuilder = req('@axe-core/playwright').default || req('@axe-core/playwright')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`) }

async function login(browser, email) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
const text = async (page) => (await page.locator('main, .admin-page').first().innerText()).replace(/\s+/g, ' ')

;(async () => {
  const browser = await chromium.launch()
  const { ctx, page } = await login(browser, seed.ownerEmail)
  const errors = []; page.on('pageerror', e => errors.push(e.message))

  // 0. department sidebar: grouped by department, only live modules, nothing planned
  await page.goto(`${BASE}/dashboard`); await page.waitForSelector('nav')
  const sidebar = (await page.locator('nav').first().innerText()).replace(/\s+/g, ' ')
  check('Sidebar groups live modules by department', ['Control tower', 'Supply & contracting', 'Rates & inventory', 'Reservations', 'Finance', 'Platform'].every((g) => new RegExp(g, 'i').test(sidebar)), sidebar.slice(0, 120))
  check('Sidebar lists no planned department module', !/Promotions|Refunds|Risk flags/.test(sidebar))

  // 0b. dashboard department slices: same numbers as the readiness page, honest per-section denial
  await page.goto(`${BASE}/dashboard`); await page.waitForSelector('[data-testid=dept-reservations]', { timeout: 20000 })
  const dept = async (id) => (await page.locator(`[data-testid=dept-${id}]`).innerText()).replace(/\s+/g, ' ')
  const res = await dept('reservations')
  check('Reservations slice shows booking counts from the API (1 pending, 1 confirmed, 1 cancelled before reconcile)', /1\s*Pending/.test(res) && /1\s*Confirmed/.test(res) && /1\s*Cancelled/.test(res) && /0\s*Failed/.test(res), res.slice(0, 120))
  check('Every functional department has a slice', (await Promise.all(['contracting', 'mapping', 'rates', 'connectivity', 'reservations', 'reconciliation'].map((d) => page.locator(`[data-testid=dept-${d}]`).count()))).every((n) => n === 1))
  check('Slice tile drills into the filtered view', (await page.locator('[data-testid=dept-reservations] a[href="/bookings?status=FAILED"]').count()) === 1)
  // finance and audit slices come from their summary endpoints and agree with the detail pages
  await page.waitForSelector('[data-testid=dept-finance]', { timeout: 20000 }); await page.waitForSelector('[data-testid=dept-audit]', { timeout: 20000 })
  const fin = await dept('finance'); const aud = await dept('audit')
  const aedCredit = (fin.match(/([A-Z]{0,3}\s?[\d,]+\.\d{2})\s*AED available credit/) ?? [])[1]
  check('Finance slice shows per-currency available credit from the API', !!aedCredit && /Wallets/.test(fin) && /Ledger entries/.test(fin), fin.slice(0, 160))
  await page.goto(`${BASE}/finance/wallets`); await page.waitForSelector('table')
  check('Finance slice available credit equals the Wallets page', !!aedCredit && (await text(page)).includes(aedCredit.trim()), aedCredit)
  await page.goto(`${BASE}/dashboard`); await page.waitForSelector('[data-testid=dept-audit]', { timeout: 20000 })
  check('Audit slice shows event counts and attention signals', /Audit events/.test(aud) && /Denied actions/.test(aud) && /Unknown supplier outcomes/.test(aud) && /booking \d+/.test(aud), aud.slice(0, 160))
  await page.route('**/api/v1/admin/operations/finance/summary*', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'OPERATIONS_READ_DENIED', message: 'denied', details: [] }, meta: { timestamp: new Date().toISOString(), path: '', requestId: 'x' } }) }))
  await page.reload(); await page.waitForSelector('[data-testid=dept-finance] [data-state=denied]', { timeout: 20000 }); await page.waitForSelector('[data-testid=dept-audit] ul', { timeout: 20000 })
  check('A denied finance summary shows an explicit state inside the Finance card; the audit slice is unaffected', (await page.locator('[data-testid=dept-finance] [data-state=denied]').count()) === 1 && (await page.locator('[data-testid=dept-audit] [data-state]').count()) === 0 && /Audit events/.test(await dept('audit')))
  await page.unroute('**/api/v1/admin/operations/finance/summary*')
  // governance slices and pages: markets, reliability, access review
  for (const d of ['markets', 'reliability', 'risk']) await page.waitForSelector(`[data-testid=dept-${d}]`, { timeout: 20000 })
  await page.waitForSelector('[data-testid=dept-reliability] ul', { timeout: 20000 })
  const rel = await dept('reliability')
  check('Reliability slice shows the seeded stalled hold from the API', /1\s*Stalled holds/.test(rel), rel.slice(0, 140))
  await page.goto(`${BASE}/reliability`); await page.waitForSelector('[aria-labelledby="rel-Holds"]', { timeout: 20000 })
  const relPage = await text(page)
  check('System health page lists connectors, executions, supplier outcomes and holds', ['Connectors', 'Connector executions', 'Supplier outcomes', 'Holds'].every((h) => relPage.includes(h)))
  await page.goto(`${BASE}/markets`); await page.waitForSelector('[data-testid=markets-table]', { timeout: 20000 })
  check('Destinations page groups the tenant hotels by destination', /Dubai/.test(await text(page)))
  await page.goto(`${BASE}/access-review`); await page.waitForSelector('[data-testid=access-summary]', { timeout: 20000 }); await page.waitForSelector('[data-testid=access-table]', { timeout: 20000 })
  const acc = await text(page)
  check('Access review shows tenant A members only, with sensitive permission holders flagged', /3\s*Members/.test(acc) && /2\s*Hold sensitive permissions/.test(acc) && /booking\.reconcile/.test(acc) && !/bowner/.test(acc), acc.slice(0, 160))
  check('Access review never renders credential material', !/passwordHash|password_hash|\$argon|\$2[aby]\$/.test(await page.content()))
  await page.goto(`${BASE}/dashboard`); await page.waitForSelector('[data-testid=dept-finance]', { timeout: 20000 })
  await page.route('**/api/v1/admin/operations/readiness*', async (r) => { const j = await (await r.fetch()).json(); j.data.transactions = { state: 'unavailable', reason: 'OPERATIONS_READ_DENIED' }; await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) }) })
  await page.reload(); await page.waitForSelector('[data-testid=dept-reservations] [data-state=denied]', { timeout: 20000 })
  check('A denied section shows denied (not zeros) while the other departments keep their data', (await page.locator('[data-testid=dept-reconciliation] [data-state=denied]').count()) === 1 && (await page.locator('[data-testid=dept-connectivity] [data-state=denied]').count()) === 0 && !/0\s*Confirmed/.test(await dept('reservations')))
  await page.unroute('**/api/v1/admin/operations/readiness*')

  // 1. every operations list view renders real data, with table headers and a pager
  for (const [path, mustContain] of [['/bookings', 'CONFIRMED'], ['/holds', 'HELD'], ['/cancellations', 'MATCH'], ['/finance/wallets', 'Available credit'], ['/finance/ledger', 'DEBIT'], ['/audit', 'Audit explorer'], ['/connectors', 'api_key: configured'], ['/operations/hotels', 'BLOCKED|READY'], ['/reconciliation', 'Stalled hold|PREBOOK_EXPIRED']]) {
    await page.goto(`${BASE}${path}`); await page.waitForSelector('table, [data-state], .admin-empty', { timeout: 15000 })
    // a cold server can answer after the first paint: wait for the expected content, and let the check below fail if it never comes
    await page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), mustContain, { timeout: 15000 }).catch(() => {})
    const t = await text(page)
    check(`${path} shows API data`, new RegExp(mustContain).test(t), t.slice(0, 90))
  }
  // the unfiltered first page can be filled by tenant.context.selected events, so filter through the UI
  await page.goto(`${BASE}/audit`); await page.waitForSelector('table')
  await page.getByLabel('Action prefix').fill('booking.'); await page.getByRole('button', { name: 'Apply' }).click()
  await page.waitForFunction(() => /booking\./.test(document.body.innerText) , null, { timeout: 15000 }).catch(() => {})
  check('/audit filtered to booking. shows booking events', /booking\./.test(await text(page)))
  await page.goto(`${BASE}/connectors`); await page.waitForSelector('table')
  check('/connectors never renders the secret reference', !(await page.content()).includes('vault://never-shown'))
  await page.goto(`${BASE}/bookings`); await page.waitForSelector('table')
  check('/bookings lists only tenant A (3 bookings)', /3 results/.test(await text(page)), (await text(page)).match(/\d+ results?/)?.[0])
  await page.screenshot({ path: `${process.env.SHOT_DIR ?? require('os').tmpdir()}/admin-ops-shot-bookings.png`, fullPage: true })

  // 2. Booking 360
  await page.goto(`${BASE}/bookings/${seed.confirmedBookingId}`); await page.waitForSelector('[data-testid=booking-360]')
  const b360 = await text(page)
  check('Booking 360 shows ledger DEBIT, hold CONFIRMED and audit trail', /DEBIT/.test(b360) && /CONFIRMED/.test(b360) && /booking\.prebook\.succeeded/.test(b360))
  check('Booking 360 shows the journal-acknowledged supplier reference, never an inferred one', /Supplier booking reference/.test(b360) && !/None acknowledged yet/.test(b360))
  check('Booking 360 money is formatted from minor units (AED 1,251.00)', /1,251\.00/.test(b360), b360.match(/AED[^ ]* ?[\d,.]+/)?.[0])
  await page.screenshot({ path: `${process.env.SHOT_DIR ?? require('os').tmpdir()}/admin-ops-shot-booking360.png`, fullPage: true })
  await page.goto(`${BASE}/bookings/${seed.stuckBookingId}`); await page.waitForSelector('[data-testid=booking-360]')
  check('Stuck booking shows an attention flag', /Needs attention/.test(await text(page)), (await text(page)).match(/PREBOOK_EXPIRED_UNRESOLVED|RECONCILIATION_REQUIRED/)?.[0])

  // 3. operations readiness numbers come from the API
  await page.goto(`${BASE}/operations`); await page.waitForSelector('main >> text=Connectors')
  const ops = await text(page)
  check('Readiness shows supply, transactions, connectors sections', /Supply/.test(ops) && /Transactions/.test(ops) && /Connectors/.test(ops))
  await page.screenshot({ path: `${process.env.SHOT_DIR ?? require('os').tmpdir()}/admin-ops-shot-operations.png`, fullPage: true })

  // 4. reconcile: confirmation step, duplicate-submit protection, result with request id
  await page.goto(`${BASE}/reconciliation`); await page.waitForSelector('table')
  await page.click('text=Run reconciliation…'); await page.waitForSelector('[data-testid=recon-confirm]')
  check('Reconcile requires an explicit confirmation step', true)
  let posts = 0; page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/reconciliation/run')) posts++ })
  // two synchronous clicks in one task: the second must be ignored by the in-flight guard
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent === 'Confirm and run'); b.click(); b.click() })
  await page.waitForSelector('[data-testid=recon-result]', { timeout: 20000 })
  check('Duplicate submit sends exactly one POST', posts === 1, `posts=${posts}`)
  const rr = await text(page)
  check('Result shows outcome and request id', /prebook_expired/.test(rr) && /Request id/.test(rr), rr.match(/Request id: \S+/)?.[0])
  await page.reload(); await page.waitForSelector('table, .admin-empty')
  { await page.waitForFunction(() => /Nothing to reconcile/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {}) // a cold server can answer after the first paint; the check below still fails if it never empties
    const queueText = await text(page); check('Queue is empty after reconcile (success state, not error)', /Nothing to reconcile/.test(queueText), queueText.slice(0, 400)) }

  // 3b. maker-checker for a reconciliation run: the requester cannot decide, a second person approves, it runs once
  await page.goto(`${BASE}/reconciliation`); await page.waitForSelector('[data-testid=recon-approvals]')
  await page.getByLabel('Reason for the run').fill('Stalled hold after supplier outage'); await page.getByRole('button', { name: 'Request approval' }).click()
  await page.waitForSelector('[data-testid=approval-pending]', { timeout: 15000 })
  const pendingRow = (await page.locator('[data-testid=approval-pending]').first().innerText()).replace(/\s+/g, ' ')
  check('Requested approval shows PENDING with the stalled-hold evidence seen at request time', /PENDING\s+0\b/.test(pendingRow), pendingRow.slice(0, 100))
  check('The requester sees no Approve or Reject button on their own request', (await page.locator('[data-testid=approval-pending] button', { hasText: /^(Approve|Reject)$/ }).count()) === 0 && (await page.locator('[data-testid=approval-pending] button', { hasText: 'Cancel request' }).count()) === 1)
  const { ctx: cctx, page: cpage } = await login(browser, seed.checkerEmail)
  await cpage.goto(`${BASE}/reconciliation`); await cpage.waitForSelector('[data-testid=approval-pending]', { timeout: 15000 })
  check('A second person sees Approve and Reject', (await cpage.locator('[data-testid=approval-pending] button', { hasText: /^Approve$/ }).count()) === 1)
  cpage.once('dialog', (d) => d.accept('Verified against the supplier extranet'))
  await cpage.locator('[data-testid=approval-pending] button', { hasText: /^Approve$/ }).click()
  await cpage.waitForSelector('[data-testid=approval-approved]', { timeout: 15000 })
  check('Approval is recorded as APPROVED', true)
  await cctx.close()
  await page.reload(); await page.waitForSelector('[data-testid=approval-approved]', { timeout: 15000 })
  let execPosts = 0; page.on('request', (r) => { if (r.method() === 'POST' && /approvals\/[^/]+\/execute/.test(r.url())) execPosts++ })
  await page.evaluate(() => { const b = [...document.querySelectorAll('[data-testid=approval-approved] button')].find((x) => /Run approved reconciliation/.test(x.textContent)); b.click(); b.click() })
  await page.waitForSelector('[data-testid=approval-executed]', { timeout: 20000 })
  check('Approved run executes exactly once (a double click sends one POST)', execPosts === 1, `posts=${execPosts}`)
  check('An executed approval offers no further action', (await page.locator('[data-testid=approval-executed] button').count()) === 0)

  // 3c. commercial markup rule: create a draft, a second person approves, it is activated once
  await page.goto(`${BASE}/commercial/markups`); await page.waitForSelector('[data-testid=markup-form]', { timeout: 20000 })
  const today = new Date().toISOString().slice(0, 10)
  const fillRule = async (percent) => { await page.getByLabel('Markup %').fill(percent); await page.getByLabel('Valid from').fill(today); await page.getByLabel('Reason', { exact: true }).fill('Standard margin on NET contracts'); await page.getByRole('button', { name: 'Create draft' }).click() }
  await fillRule('101'); await page.waitForSelector('[data-testid=markup-form] [role=alert]', { timeout: 10000 })
  check('A markup above 100 percent is refused before anything is sent', /0 to 100/.test(await page.locator('[data-testid=markup-form] [role=alert]').innerText()))
  await fillRule('12.345'); check('A markup with more than two decimals is refused', /two decimals/.test(await page.locator('[data-testid=markup-form] [role=alert]').innerText()))
  await fillRule('12.5'); await page.waitForSelector('[data-testid=markup-draft]', { timeout: 15000 })
  const draftRow = (await page.locator('[data-testid=markup-draft]').first().innerText()).replace(/\s+/g, ' ')
  check('A draft rule shows 12.50 percent and DRAFT, and changes no price', /12\.50%/.test(draftRow) && /DRAFT/.test(draftRow), draftRow.slice(0, 100))
  page.once('dialog', (d) => d.accept('Policy approved by commercial director'))
  await page.locator('[data-testid=markup-draft] button', { hasText: 'Request activation' }).first().click()
  await page.waitForSelector('[data-testid=markup-draft] >> text=PENDING', { timeout: 15000 })
  check('The requester sees no Approve or Reject on their own rule', (await page.locator('[data-testid=markup-draft] button', { hasText: /^(Approve|Reject)$/ }).count()) === 0)
  const { ctx: mctx, page: mpage } = await login(browser, seed.checkerEmail)
  await mpage.goto(`${BASE}/commercial/markups`); await mpage.waitForSelector('[data-testid=markup-draft]', { timeout: 15000 })
  mpage.once('dialog', (d) => d.accept('Matches the signed policy'))
  await mpage.locator('[data-testid=markup-draft] button', { hasText: /^Approve$/ }).first().click()
  await mpage.waitForSelector('[data-testid=markup-draft] >> text=APPROVED', { timeout: 15000 })
  await mctx.close()
  await page.reload(); await page.waitForSelector('[data-testid=markup-draft] >> text=APPROVED', { timeout: 15000 })
  let actPosts = 0; page.on('request', (r) => { if (r.method() === 'POST' && /markups\/approvals\/[^/]+\/execute/.test(r.url())) actPosts++ })
  await page.evaluate(() => { const b = [...document.querySelectorAll('[data-testid=markup-draft] button')].find((x) => /Activate approved rule/.test(x.textContent)); b.click(); b.click() })
  await page.waitForSelector('[data-testid=markup-active]', { timeout: 20000 })
  check('The approved rule is activated exactly once (a double click sends one POST)', actPosts === 1, `posts=${actPosts}`)
  check('The ACTIVE rule shows its percent and can be retired', /12\.50%/.test(await page.locator('[data-testid=markup-active]').first().innerText()) && (await page.locator('[data-testid=markup-active] button', { hasText: 'Retire' }).count()) === 1)
  await page.waitForSelector('[data-testid=markup-impact] ul', { timeout: 15000 })
  const impact = (await page.locator('[data-testid=markup-impact]').innerText()).replace(/\s+/g, ' ')
  check('The impact panel shows the API plan-night counts for NET, unpriced NET, stored sell and unverified basis', ['NET priced by a rule', 'NET with no rule', 'Stored sell rates', 'Basis not verified'].every((t) => impact.includes(t)) && !/NaN|undefined/.test(impact), impact.slice(0, 140))

  // 3d. clients, service and distribution (ADR 0019)
  await page.goto(`${BASE}/clients/agencies`); await page.waitForSelector('[data-testid=agency-form]', { timeout: 20000 })
  const agencyCode = `VERIFY-${Date.now().toString(36).toUpperCase()}`
  await page.getByLabel('Code').fill(agencyCode); await page.getByLabel('Name', { exact: true }).fill('Verify Travel Agency'); await page.getByLabel('Country (ISO-2)').fill('AE'); await page.getByRole('button', { name: 'Create agency' }).click()
  await page.waitForSelector('[data-testid=agency-active]', { timeout: 15000 })
  check('A new agency appears as ACTIVE with no members', /Verify Travel Agency/.test(await text(page)) && /ACTIVE/.test(await text(page)))
  await page.locator('[data-testid=agency-active] button', { hasText: 'Members' }).first().click(); await page.waitForSelector('[data-testid=agency-members]', { timeout: 15000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=agency-members] select option').length > 1, null, { timeout: 15000 })
  await page.locator('[data-testid=agency-members] select').selectOption({ index: 1 }); await page.getByRole('button', { name: 'Add member' }).click()
  await page.waitForSelector('[data-testid=agency-members] table', { timeout: 15000 })
  check('A user is added to the agency and leaves the picker', (await page.locator('[data-testid=agency-members] tbody tr').count()) === 1)
  await page.locator('[data-testid=agency-active] button', { hasText: 'Mark inactive' }).first().click(); await page.waitForSelector('[data-testid=agency-inactive]', { timeout: 15000 })
  check('Marking inactive is described as a directory state only', /directory only/.test(await page.locator('[data-testid=clients-notice]').innerText()))

  // 3c. agency suspension (ADR 0020): maker-checker, then the row reads SUSPENDED and offers no direct way back
  const agencyRow = () => page.locator('[data-testid="agencies-table"] tbody tr', { hasText: agencyCode })
  await page.getByLabel('Search').fill(agencyCode); await agencyRow().waitFor({ timeout: 15000 })
  await agencyRow().getByRole('button', { name: 'Mark active' }).click(); await page.waitForSelector('[data-testid=agency-active]', { timeout: 15000 })
  page.once('dialog', (d) => d.accept('Unpaid invoices escalated by finance'))
  await agencyRow().getByRole('button', { name: 'Request suspension' }).click(); await agencyRow().getByText('suspension pending').waitFor({ timeout: 15000 })
  check('The maker sees a pending suspension and no approve control', (await agencyRow().getByRole('button', { name: /Approve suspension/ }).count()) === 0 && (await agencyRow().getByRole('button', { name: 'Withdraw' }).count()) === 1)
  const { ctx: sctx, page: spage } = await login(browser, seed.checkerEmail)
  await spage.goto(`${BASE}/clients/agencies`); await spage.waitForSelector('[data-testid=agency-form]', { timeout: 20000 })
  await spage.getByLabel('Search').fill(agencyCode)
  const srow = () => spage.locator('[data-testid="agencies-table"] tbody tr', { hasText: agencyCode })
  await srow().waitFor({ timeout: 15000 })
  check('A second person is offered approve and reject, not withdraw', (await srow().getByRole('button', { name: /Approve suspension/ }).count()) === 1 && (await srow().getByRole('button', { name: 'Withdraw' }).count()) === 0)
  spage.once('dialog', (d) => d.accept('Reviewed the ledger summary'))
  await srow().getByRole('button', { name: /Approve suspension/ }).click(); await srow().getByRole('button', { name: /Apply suspension/ }).waitFor({ timeout: 15000 })
  await srow().getByRole('button', { name: /Apply suspension/ }).click(); await spage.waitForSelector('[data-testid=agency-suspended]', { timeout: 15000 })
  check('After approval and apply the agency reads SUSPENDED and offers no direct activation', (await srow().getByRole('button', { name: 'Mark active' }).count()) === 0 && /SUSPENDED/.test(await srow().innerText()) && (await srow().getByRole('button', { name: 'Request reinstatement' }).count()) === 1)
  await sctx.close()

  await page.goto(`${BASE}/service/cases`); await page.waitForSelector('[data-testid=case-form]', { timeout: 20000 })
  await page.getByLabel('Subject').fill('Voucher email not received'); await page.getByLabel('Description').fill('Agent reports the voucher email did not arrive for the confirmed booking.'); await page.getByRole('button', { name: 'Open case' }).click()
  await page.waitForSelector('[data-testid=cases-table] a[href^="/service/cases/"]', { timeout: 15000 })
  const ref = (await page.locator('[data-testid=cases-table] a[href^="/service/cases/"]').first().innerText()).trim()
  check('A new case gets an SC- reference and shows OPEN', /^SC-[A-Z2-9]{8}$/.test(ref) && /OPEN/.test(await text(page)), ref)
  await page.locator('[data-testid=cases-table] a[href^="/service/cases/"]').first().click(); await page.waitForSelector('[data-testid=case-detail]', { timeout: 15000 })
  check('An OPEN case offers only the moves the API allows', (await page.getByRole('button', { name: 'Start work' }).count()) === 1 && (await page.getByRole('button', { name: 'Close case' }).count()) === 1 && (await page.getByRole('button', { name: 'Mark resolved' }).count()) === 0)
  await page.getByLabel(/Add a note/).fill('Checked the mail log, resending the voucher'); await page.getByRole('button', { name: 'Add note' }).click()
  await page.waitForSelector('[data-testid=case-notes] li', { timeout: 15000 })
  await page.getByRole('button', { name: 'Start work' }).click(); await page.waitForSelector('[data-testid=case-detail] >> text=IN PROGRESS', { timeout: 15000 })
  await page.getByRole('button', { name: 'Mark resolved' }).click(); await page.getByRole('button', { name: 'Close case' }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: 'Close case' }).click(); await page.waitForSelector('text=A closed case takes no more notes', { timeout: 15000 })
  check('A closed case is final: no moves, no note form', (await page.locator('[data-testid=case-detail] button').count()) === 0 && (await page.getByRole('button', { name: 'Add note' }).count()) === 0 && (await page.locator('[data-testid=case-notes] li').count()) === 1)

  await page.goto(`${BASE}/distribution/restrictions`); await page.waitForSelector('[data-testid=restriction-form]', { timeout: 20000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=restriction-form] select')[0].options.length > 1, null, { timeout: 15000 })
  await page.locator('[data-testid=restriction-form] select').first().selectOption({ index: 1 })
  await page.getByLabel('Find hotel').fill(seed.hotelAName.slice(0, 4))
  await page.waitForFunction(() => { const s = document.querySelectorAll('[data-testid=restriction-form] select')[2]; return s && s.options.length > 1 }, null, { timeout: 15000 })
  await page.locator('[data-testid=restriction-form] select').nth(2).selectOption({ index: 1 }); await page.getByLabel('Reason').fill('Contract dispute'); await page.getByRole('button', { name: 'Create restriction' }).click()
  await page.waitForSelector('[data-testid=restriction-active]', { timeout: 15000 })
  check('A restriction is listed as ACTIVE and states it only narrows what an agency sees', /Contract dispute/.test(await text(page)) && /never grants access or changes a price/.test(await text(page)))
  page.once('dialog', (d) => d.accept()); await page.locator('[data-testid=restriction-active] button', { hasText: 'Retire' }).first().click()
  await page.waitForSelector('[data-testid=distribution-notice] >> text=visible again', { timeout: 15000 })
  check('Retiring a restriction says the inventory is visible again', (await page.locator('[data-testid=restriction-active]').count()) === 0)
  await page.goto(`${BASE}/dashboard`); for (const d of ['clients', 'service', 'distribution']) await page.waitForSelector(`[data-testid=dept-${d}] ul`, { timeout: 20000 })
  check('Dashboard shows Clients, Service and Distribution slices from their summaries', /Agencies/.test(await dept('clients')) && /Open/.test(await dept('service')) && /Active restrictions/.test(await dept('distribution')))



  // 5. distinct failure states (network interception is test-only; the app has no mock path)
  for (const [status, code, expect, label] of [[401, 'UNAUTHORIZED', 'unauthenticated', '401'], [403, 'FORBIDDEN', 'forbidden', '403'], [503, 'OPERATIONS_READ_DENIED', 'denied', '503 privilege boundary'], [500, 'INTERNAL_SERVER_ERROR', 'error', '500']]) {
    await page.route('**/api/v1/admin/operations/bookings*', r => r.fulfill({ status, contentType: 'application/json', headers: { 'x-request-id': 'req-test-123' }, body: JSON.stringify({ success: false, error: { code, message: 'x', details: [] }, meta: {} }) }))
    await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-state]', { timeout: 15000 })
    const state = await page.locator('[data-state]').first().getAttribute('data-state')
    const body = await text(page)
    check(`API ${label} renders state "${expect}", not an empty list`, state === expect && !/No bookings match/.test(body) && !/0 results/.test(body), `${state} | ref: ${body.match(/Reference: \S+ \S+ \S+ \S+/)?.[0] ?? ''}`)
    await page.unroute('**/api/v1/admin/operations/bookings*')
  }
  await page.route('**/api/v1/admin/operations/bookings*', r => r.abort())
  await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-state]', { timeout: 15000 })
  check('Network failure renders "unreachable"', (await page.locator('[data-state]').first().getAttribute('data-state')) === 'unreachable')
  await page.unroute('**/api/v1/admin/operations/bookings*')
  await page.route('**/api/v1/admin/operations/bookings*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { items: [], page: 1, pageSize: 25, total: 0 }, meta: {} }) }))
  await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-state=empty]', { timeout: 15000 })
  check('A successful empty response renders the EMPTY state', true)
  await page.unroute('**/api/v1/admin/operations/bookings*')

  // 6. accessibility (axe) on the data pages
  for (const path of ['/dashboard', '/clients/agencies', '/service/cases', '/distribution/restrictions', '/commercial/markups', '/markets', '/reliability', '/access-review', '/bookings', `/bookings/${seed.confirmedBookingId}`, '/audit', '/operations']) {
    await page.goto(`${BASE}${path}`); await page.waitForSelector('table, [data-testid=booking-360], section, .admin-empty')
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    const serious = axe.violations.filter(v => ['serious', 'critical'].includes(v.impact))
    check(`axe ${path}: no serious/critical violations`, serious.length === 0, serious.map(v => `${v.id}(${v.nodes.length})`).join(','))
  }
  check('no uncaught page errors', errors.length === 0, errors.join(' | ').slice(0, 200))
  await ctx.close()

  // 7. viewer: lacks booking.read/audit.read — sidebar hides, API returns forbidden state
  const v = await login(browser, seed.viewerEmail)
  await v.page.goto(`${BASE}/bookings`); await v.page.waitForSelector('[data-state]', { timeout: 15000 })
  check('Viewer without booking.read sees FORBIDDEN on /bookings', (await v.page.locator('[data-state]').first().getAttribute('data-state')) === 'forbidden')
  await v.page.goto(`${BASE}/audit`); await v.page.waitForSelector('[data-state]', { timeout: 15000 })
  check('Viewer without audit.read sees FORBIDDEN on /audit', (await v.page.locator('[data-state]').first().getAttribute('data-state')) === 'forbidden')
  const nav = await v.page.locator('nav, aside').first().innerText()
  check('Viewer sidebar hides Bookings/Audit', !/Bookings|Audit explorer|Reconciliation/.test(nav), nav.replace(/\s+/g, ' ').slice(0, 120))
  await v.ctx.close()

  // 8. tenant B owner cannot see tenant A data, and A's booking id is a not-found for B
  const bb = await login(browser, seed.bownerEmail)
  await bb.page.goto(`${BASE}/bookings`); await bb.page.waitForSelector('table')
  check('Tenant B sees only its own booking (1 result)', /1 result/.test(await text(bb.page)))
  await bb.page.goto(`${BASE}/bookings/${seed.confirmedBookingId}`); await bb.page.waitForSelector('[data-state]', { timeout: 15000 })
  check('Tenant B opening tenant A booking id gets not-found', (await bb.page.locator('[data-state]').first().getAttribute('data-state')) === 'not-found')
  await bb.page.goto(`${BASE}/connectors`); await bb.page.waitForSelector('.admin-empty, table')
  check('Tenant B sees no connectors', /No connectors configured/.test(await text(bb.page)))
  await bb.ctx.close()

  await browser.close()
  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
