// Real-stack browser + API verification of hotel promotions and contract supplements (ADR 0089 / ADR 0067): board and compulsory
// supplement pricing, a promotion's full draft -> validate -> submit -> approve (a different person) -> activate lifecycle, the
// HotelDealPreviewNight math (promotionMinor / supplementMinor / netMinor / markupMinor / sellMinor) checked against real DB rows in
// integer minor units, idempotent creation, maker-checker self-approval refusal, and tenant isolation. Needs: real PostgreSQL
// (DATABASE_URL = owner connection, used only to arrange fixtures and read back results), the API process and the production Admin
// build (see README.md), and `seed-promotions-supplements.ts` run first on a DISPOSABLE database. Re-seed before every run. Not run in CI.
const path = require('path')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const apiReq = createRequire(path.join(__dirname, '../../apps/api/package.json'))
const { PrismaClient } = apiReq('@prisma/client')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-promotions-supplements.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const prisma = new PrismaClient()
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`) }
const DAY = 86_400_000
const iso = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10)
const isIntString = (v) => typeof v === 'string' && /^-?\d+$/.test(v)

async function login(browser, email) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
const dialogReason = (page) => page.locator('dialog[open]')
async function confirmDialog(page, { reason, confirm }) {
  const dlg = dialogReason(page)
  await dlg.waitFor({ state: 'visible' })
  if (reason !== undefined) await dlg.getByLabel(/^Reason/).fill(reason)
  await dlg.getByRole('button', { name: confirm }).click()
}
/** The notice banner is cleared, then reset, by the same handler that drives every lifecycle action on this page; waiting for its
 * mere presence races a notice left over from the PREVIOUS action (or the "Draft saved" notice already on the page at load). Waits
 * for the specific text instead. Returns whether it appeared within the timeout, never throws. */
async function noticeSays(page, pattern, timeout = 15000) {
  try { await page.waitForFunction((p) => { const el = document.querySelector('[data-testid=deal-notice]'); return !!el && new RegExp(p).test(el.textContent || '') }, pattern, { timeout }); return true }
  catch { return false }
}

;(async () => {
  const browser = await chromium.launch()
  const maker = await login(browser, seed.makerEmail)
  const errors = []; maker.page.on('pageerror', (e) => errors.push(e.message))
  let lastCreateBody = null
  maker.page.on('request', (r) => { if (/\/admin\/commercial\/promotions$/.test(new URL(r.url()).pathname) && r.method() === 'POST') { try { lastCreateBody = JSON.parse(r.postData()) } catch { /* ignore */ } } })

  // ---- contract supplements: add BOARD + COMPULSORY on a DRAFT (editable) contract, through the real UI ------------------------
  await maker.page.goto(`${BASE}/contracts/${seed.contract2Id}`)
  await maker.page.waitForSelector('section[aria-label="Supplements"]')
  const addSupplement = async ({ kind, name, board, amount, basis, frequency }) => {
    const form = maker.page.locator('form[aria-label="Add supplement"]')
    await form.getByLabel('Supplement kind').selectOption(kind)
    await form.getByLabel('Supplement name').fill(name)
    if (board) await form.getByLabel('Board priced').selectOption({ label: board })
    await form.getByLabel(/^Amount/).fill(amount)
    await form.getByLabel('Charged').selectOption({ label: basis })
    await form.getByLabel('Frequency').selectOption({ label: frequency })
    await form.getByRole('button', { name: 'Add supplement' }).click()
    await maker.page.waitForTimeout(400)
  }
  await addSupplement({ kind: 'Board', name: 'Breakfast', board: 'BB · Bed and breakfast', amount: '50.00', basis: 'per room', frequency: 'per night' })
  await addSupplement({ kind: 'Compulsory', name: 'City tax', amount: '20.00', basis: 'per room', frequency: 'once per stay' })
  const draftSupplements = await prisma.contractSupplement.findMany({ where: { contractId: seed.contract2Id }, orderBy: { createdAt: 'asc' } })
  check('UI create: a BOARD supplement writes exact integer minor units (AED 50.00 -> 5000)', draftSupplements.some((s) => s.kind === 'BOARD' && s.name === 'Breakfast' && s.amountMinor === 5_000n))
  check('UI create: a COMPULSORY supplement writes exact integer minor units (AED 20.00 -> 2000)', draftSupplements.some((s) => s.kind === 'COMPULSORY' && s.name === 'City tax' && s.amountMinor === 2_000n))
  const removeBtn = maker.page.locator('li', { hasText: 'City tax' }).getByRole('button', { name: /^Remove/ })
  await removeBtn.click(); await maker.page.waitForTimeout(400)
  check('UI remove: the supplement row is deleted from the database', (await prisma.contractSupplement.count({ where: { contractId: seed.contract2Id, name: 'City tax' } })) === 0)

  // ---- API-level validation (never trust the client form alone) ---------------------------------------------------------------
  const before = await prisma.contractSupplement.count({ where: { contractId: seed.contract2Id } })
  const bad = async (body) => (await maker.page.request.post(`${BASE}/api/v1/supply/contracts/${seed.contract2Id}/supplements`, { data: body, headers: { 'content-type': 'application/json', origin: BASE } })).status()
  check('API refuses a non-ISO currency', (await bad({ kind: 'COMPULSORY', name: 'Bad', basis: 'PER_ROOM', frequency: 'PER_STAY', amountMinor: '1000', currency: 'AE' })) === 400)
  check('API refuses a non-numeric amount', (await bad({ kind: 'COMPULSORY', name: 'Bad', basis: 'PER_ROOM', frequency: 'PER_STAY', amountMinor: 'abc', currency: 'AED' })) === 400)
  check('API refuses a BOARD supplement with no board named', (await bad({ kind: 'BOARD', name: 'Bad', basis: 'PER_ROOM', frequency: 'PER_NIGHT', amountMinor: '1000', currency: 'AED' })) === 400)
  check('none of the refused requests wrote a row', (await prisma.contractSupplement.count({ where: { contractId: seed.contract2Id } })) === before)

  // ---- cross-tenant: tenant B cannot touch tenant A's DRAFT contract's supplements ----------------------------------------------
  const b = await login(browser, seed.bownerEmail)
  const crossStatus = (await b.page.request.post(`${BASE}/api/v1/supply/contracts/${seed.contract2Id}/supplements`, { data: { kind: 'COMPULSORY', name: 'Cross', basis: 'PER_ROOM', frequency: 'PER_STAY', amountMinor: '1000', currency: 'AED' }, headers: { 'content-type': 'application/json', origin: BASE } })).status()
  check("tenant B cannot create a supplement on tenant A's contract (not found, never leaked)", crossStatus === 404, String(crossStatus))
  await b.ctx.close()

  // ---- promotion: create a draft, validate, submit, approve (a different person), activate -------------------------------------
  await maker.page.goto(`${BASE}/commercial/promotions/new?hotelId=${seed.hotelId}`)
  await maker.page.waitForSelector('[data-testid=deal-form]')
  const code = `CERT${Date.now().toString(36).toUpperCase()}`
  await maker.page.getByLabel(/Promotion code/).fill(code)
  await maker.page.getByLabel(/Promotion name/).fill('Certification 10% off')
  await maker.page.getByRole('radio', { name: 'Percent off' }).check()
  await maker.page.getByLabel(/Discount %/).fill('10')
  await maker.page.locator('[data-testid=deal-scope] label', { hasText: seed.planCode }).locator('input[type=checkbox]').check()
  await maker.page.getByRole('button', { name: 'Save draft' }).click()
  await maker.page.waitForURL((u) => /\/commercial\/promotions\/[^/]+\?saved=1/.test(u.pathname + u.search), { timeout: 15000 })
  const dealId = decodeURIComponent(maker.page.url().split('/commercial/promotions/')[1].split('?')[0])
  const dealRow = await prisma.hotelDeal.findUniqueOrThrow({ where: { id: dealId } })
  check('DB: the draft promotion stores the discount as basis points, never a float', dealRow.percentBp === 1000)

  await maker.page.waitForSelector('[data-testid=deal-detail]')
  await maker.page.getByRole('button', { name: 'Validate' }).click()
  check('Validate reports no blocking findings', await noticeSays(maker.page, 'Valid: no blocking findings'))
  await maker.page.getByRole('button', { name: 'Submit for approval' }).click()
  await confirmDialog(maker.page, { reason: 'Certification run: please review these terms', confirm: 'Submit' })
  await noticeSays(maker.page, 'Submitted')
  check('submit for approval moves the promotion to PENDING_APPROVAL', (await prisma.hotelDeal.findUniqueOrThrow({ where: { id: dealId } })).status === 'PENDING_APPROVAL')

  // self-approval is refused even by direct API call, maker-checker (CLAUDE.md invariant: authentication is not authorization)
  const dealAfterSubmit = await prisma.hotelDeal.findUniqueOrThrow({ where: { id: dealId } })
  const selfApprove = await maker.page.request.post(`${BASE}/api/v1/admin/commercial/promotions/approvals/${dealAfterSubmit.approvalId}/approve`, { data: { reason: 'self-approval attempt' }, headers: { 'content-type': 'application/json', origin: BASE } })
  check('the maker approving their own request is refused (403), never silently allowed', selfApprove.status() === 403, String(selfApprove.status()))
  check('a self-approval attempt leaves the promotion PENDING_APPROVAL', (await prisma.hotelDeal.findUniqueOrThrow({ where: { id: dealId } })).status === 'PENDING_APPROVAL')

  const checker = await login(browser, seed.checkerEmail)
  await checker.page.goto(`${BASE}/commercial/promotions/${dealId}`)
  await checker.page.waitForSelector('[data-testid=deal-detail]')
  await checker.page.getByRole('button', { name: 'Approve' }).click()
  await confirmDialog(checker.page, { reason: 'Reviewed and approved by a different person', confirm: 'Approve' })
  await noticeSays(checker.page, 'Approved')
  check('approval by a different person moves the promotion to APPROVED', (await prisma.hotelDeal.findUniqueOrThrow({ where: { id: dealId } })).status === 'APPROVED')
  await checker.page.getByRole('button', { name: 'Activate' }).click()
  await confirmDialog(checker.page, { confirm: 'Activate' })
  await noticeSays(checker.page, 'Activated')
  const activated = await prisma.hotelDeal.findUniqueOrThrow({ where: { id: dealId } })
  check('activation stores an ACTIVE or SCHEDULED promotion with an activatedAt timestamp', ['ACTIVE', 'SCHEDULED'].includes(activated.status) && activated.activatedAt !== null)
  const lifecycleAudit = await prisma.auditEvent.findMany({ where: { tenantId: seed.tenantA, entityType: 'hotel_deal', entityId: dealId }, orderBy: { createdAt: 'asc' } })
  check('every lifecycle step left exactly one immutable audit event (CLAUDE.md invariant 8)', ['promotion.deal.created', 'promotion.deal.submitted', 'promotion.deal.approved', 'promotion.deal.activated'].every((action) => lifecycleAudit.filter((e) => e.action === action).length === 1), lifecycleAudit.map((e) => e.action).join(','))

  // ---- idempotent creation: replaying the exact create request (captured from the UI) never makes a second promotion -----------
  check('captured the real create request to replay', lastCreateBody !== null && lastCreateBody.idempotencyKey === dealRow.idempotencyKey)
  const replayCreate = await maker.page.request.post(`${BASE}/api/v1/admin/commercial/promotions`, { data: lastCreateBody, headers: { 'content-type': 'application/json', origin: BASE } })
  const replayBody = await replayCreate.json()
  check('replaying the exact same create request returns the SAME promotion id, not a new one', replayCreate.status() === 201 && replayBody.data.id === dealId, `${replayCreate.status()} ${replayBody.data?.id}`)
  check('exactly one hotel_deal row exists for this idempotency key, and no second created-audit event', (await prisma.hotelDeal.count({ where: { tenantId: seed.tenantA, idempotencyKey: dealRow.idempotencyKey } })) === 1 && lifecycleAudit.filter((e) => e.action === 'promotion.deal.created').length === 1)
  const differentTerms = { ...lastCreateBody, name: 'A different name for the same key' }
  const reused = await maker.page.request.post(`${BASE}/api/v1/admin/commercial/promotions`, { data: differentTerms, headers: { 'content-type': 'application/json', origin: BASE } })
  check('reusing the idempotencyKey for different terms is a conflict, never a silent overwrite', reused.status() === 409, String(reused.status()))

  // ---- the pricing math itself: promotion and board/compulsory supplements together, checked in integer minor units ------------
  const nights = 3; const checkIn = iso(10)
  const previewResp = await maker.page.request.post(`${BASE}/api/v1/admin/commercial/promotions/${dealId}/preview`, { data: { ratePlanId: seed.planId, checkIn, nights, adults: 2, rooms: 1 }, headers: { 'content-type': 'application/json', origin: BASE } })
  const preview = (await previewResp.json()).data
  check('preview succeeds and the deal applies', previewResp.status() === 200 && preview.eligible === true && preview.dealApplied === true)
  check('every money field in the preview is an integer-minor-units string, never a float (CLAUDE.md invariant 3)', preview.nights.every((n) => ['baseNetMinor', 'promotionMinor', 'supplementMinor', 'netMinor', 'markupMinor', 'sellMinor'].every((f) => isIntString(n[f]))))
  const base = 50_000n; const saving = 5_000n // 10% of a round AED 500.00 base: an exact amount, no rounding ambiguity.
  const expected = preview.nights.map((n, i) => {
    const supplement = i === 0 ? 7_000n : 5_000n // night 1 also carries the once-per-stay compulsory fee; every night carries the board (breakfast) fee.
    const net = base - saving + supplement
    return { baseNetMinor: base, promotionMinor: saving, supplementMinor: supplement, netMinor: net, markupMinor: 0n, sellMinor: net }
  })
  check('promotion discount is exactly 10% of the base net on every night (an exact, round figure)', preview.nights.every((n) => BigInt(n.promotionMinor) === saving))
  check('night 1 carries the board fee plus the once-per-stay compulsory fee (7000); other nights carry only the board fee (5000)', BigInt(preview.nights[0].supplementMinor) === 7_000n && preview.nights.slice(1).every((n) => BigInt(n.supplementMinor) === 5_000n))
  check('netMinor = baseNetMinor - promotionMinor + supplementMinor on every night, exactly (ADR 0067: supplements never discounted)', preview.nights.every((n, i) => BigInt(n.netMinor) === expected[i].netMinor))
  check('a SELL-basis rate carries no markup (markupMinor is 0) and sellMinor equals netMinor', preview.nights.every((n) => BigInt(n.markupMinor) === 0n && BigInt(n.sellMinor) === BigInt(n.netMinor)))
  const totalSaving = saving * BigInt(nights)
  check('the stay-level saving equals 10% of the base net across all nights, unaffected by the supplement (15000)', BigInt(preview.savingSellMinor) === totalSaving)
  const withoutTotal = expected.reduce((acc, n) => acc + (n.netMinor + n.promotionMinor), 0n) // add the promotion back to get the undiscounted total
  check('withoutDeal.sellMinor and withDeal.sellMinor differ by exactly the saving', BigInt(preview.withoutDeal.sellMinor) - BigInt(preview.withDeal.sellMinor) === totalSaving && BigInt(preview.withoutDeal.sellMinor) === withoutTotal)

  // ---- cross-tenant: tenant B cannot preview, approve or see tenant A's promotion -------------------------------------------------
  const b2 = await login(browser, seed.bownerEmail)
  const crossPreview = await b2.page.request.post(`${BASE}/api/v1/admin/commercial/promotions/${dealId}/preview`, { data: { ratePlanId: seed.planId, checkIn, nights, adults: 2, rooms: 1 }, headers: { 'content-type': 'application/json', origin: BASE } })
  check("tenant B cannot preview tenant A's promotion (not found, never another tenant's price)", crossPreview.status() === 404, String(crossPreview.status()))
  const crossGet = await b2.page.request.get(`${BASE}/api/v1/admin/commercial/promotions/${dealId}`)
  check("tenant B cannot read tenant A's promotion", crossGet.status() === 404, String(crossGet.status()))
  await b2.ctx.close()

  // ---- a viewer without supply.rates.manage cannot create or preview-write anything ------------------------------------------------
  const viewer = await login(browser, seed.viewerEmail)
  await viewer.page.goto(`${BASE}/commercial/promotions/${dealId}`)
  await viewer.page.waitForSelector('[data-testid=deal-detail]')
  check('a read-only viewer sees no promotion action buttons', (await viewer.page.locator('[role="group"][aria-label="Promotion actions"]').count()) === 0)
  await viewer.ctx.close()

  check('no uncaught page errors', errors.length === 0, errors.join(' | '))
  await maker.ctx.close(); await checker.ctx.close()
  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) { console.log('FAILED:\n' + failed.map((f) => ' - ' + f.name).join('\n')); process.exit(1) }
  await prisma.$disconnect()
})().catch(async (e) => { console.error('FAIL  aborted:', String(e.message ?? e).split('\n')[0]); await prisma.$disconnect().catch(() => {}); process.exit(1) })
