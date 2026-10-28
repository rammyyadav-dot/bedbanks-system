// Real-stack browser + API verification of Room Event Master and event/exhibition supplements (ADR 0089 Phase 2/3) — the real "event
// overlay" feature: an approved event, a commercial supplement bound to one contract (and optionally one rate plan), its own
// draft -> submit -> approve (a different person) -> activate lifecycle with an immutable version snapshot, FIXED and PERCENTAGE
// amounts, stacking/priority resolution and the fail-closed ambiguous-priority conflict, a maker-checker amendment, and the Rate
// Impact Preview checked against real DB rows in integer minor units. Needs: real PostgreSQL (DATABASE_URL = owner connection), the
// API process and the production Admin build (see README.md), and `seed-event-supplements.ts` run first on a DISPOSABLE database.
// Re-seed before every run. Not run in CI.
const path = require('path')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const apiReq = createRequire(path.join(__dirname, '../../apps/api/package.json'))
const { PrismaClient } = apiReq('@prisma/client')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-event-supplements.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const prisma = new PrismaClient()
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`) }
const DAY = 86_400_000
const iso = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10)

async function login(browser, email) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
/** Every transition on this screen asks for a reason through window.prompt; `values` are the sequential prompt answers it needs. */
async function withPrompts(page, values, action) {
  for (const v of values) page.once('dialog', (d) => d.accept(v))
  await action()
}
const supplementRow = (page, evidenceRef) => page.locator(`tr:has-text("${evidenceRef}")`)

;(async () => {
  const browser = await chromium.launch()
  const maker = await login(browser, seed.makerEmail)
  const { page } = maker
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))

  // ---- Room Event Master: create, submit, approve by a different person --------------------------------------------------------
  await page.goto(`${BASE}/room-events`)
  await page.waitForSelector('[data-testid=room-event-form]')
  const eventName = `Certification Expo ${Date.now().toString(36)}`
  const form = page.getByTestId('room-event-form')
  await form.getByLabel('Name').fill(eventName)
  await form.getByLabel('Type').selectOption('EXHIBITION')
  await form.getByLabel('City').fill('Dubai')
  await form.getByLabel('Country').fill('AE')
  await form.getByLabel('Event start').fill(iso(30))
  await form.getByLabel('Event end').fill(iso(35))
  await form.getByLabel('Reference').fill('REF-CERT-1')
  await form.getByRole('button', { name: 'Create draft' }).click()
  await page.waitForSelector('[data-testid=room-event-notice]')
  const roomEvent = await prisma.roomEvent.findFirstOrThrow({ where: { tenantId: seed.tenantA, name: eventName } })
  check('DB: the new Room Event is DRAFT and prices nothing yet', roomEvent.status === 'DRAFT')

  await page.goto(`${BASE}/room-events/${roomEvent.id}`)
  await page.waitForSelector('text=' + eventName)
  await withPrompts(page, ['Certification: submit the event for approval'], () => page.getByRole('button', { name: 'Submit for approval' }).click())
  await page.waitForTimeout(500)
  check('submit moves the Room Event to PENDING_APPROVAL', (await prisma.roomEvent.findUniqueOrThrow({ where: { id: roomEvent.id } })).status === 'PENDING_APPROVAL')

  const eventApproval = await prisma.approvalRequest.findFirstOrThrow({ where: { tenantId: seed.tenantA, entityType: 'room_event', entityId: roomEvent.id, status: 'PENDING' } })
  const selfApprove = await page.request.post(`${BASE}/api/v1/admin/room-event-approvals/${eventApproval.id}/approve`, { data: { reason: 'self-approval attempt' }, headers: { 'content-type': 'application/json', origin: BASE } })
  check('the maker approving their own Room Event request is refused (403), maker-checker holds', selfApprove.status() === 403, String(selfApprove.status()))

  const checker = await login(browser, seed.checkerEmail)
  await checker.page.goto(`${BASE}/room-events/${roomEvent.id}`)
  await checker.page.waitForSelector('text=' + eventName)
  await withPrompts(checker.page, ['Reviewed and approved by a different person'], () => checker.page.getByRole('button', { name: 'Approve' }).click())
  await checker.page.waitForTimeout(500)
  const approvedEvent = await prisma.roomEvent.findUniqueOrThrow({ where: { id: roomEvent.id } })
  check('approval by a different person moves the Room Event to APPROVED', approvedEvent.status === 'APPROVED')
  check('the approver is recorded, and is not the maker who created the event', approvedEvent.approvedById !== null && approvedEvent.approvedById !== roomEvent.createdById)

  // ---- event supplement: FIXED, PER_ROOM, PER_NIGHT, bound to one contract and one rate plan ------------------------------------
  await page.goto(`${BASE}/room-events/${roomEvent.id}`)
  await page.waitForSelector('[aria-label="New event supplement"]')
  const supForm = page.locator('[aria-label="New event supplement"]')
  await supForm.getByLabel('Contract id').fill(seed.contractId)
  await supForm.getByLabel(/Rate plan id/).fill(seed.planId)
  await supForm.getByLabel('Amount kind').selectOption('FIXED')
  await supForm.getByLabel('Basis').selectOption('PER_ROOM')
  await supForm.getByLabel('Frequency').selectOption('PER_NIGHT')
  await supForm.getByLabel(/Amount \(minor units\)/).fill('3000')
  await supForm.getByLabel('Currency').fill('AED')
  await supForm.getByLabel('Valid from').fill(iso(5))
  await supForm.getByLabel('Valid to').fill(iso(40))
  await supForm.getByLabel('Priority').fill('0')
  await supForm.getByLabel('Evidence').fill('Supplier notice EVT-FIXED')
  await supForm.getByRole('button', { name: 'Create draft' }).click()
  await page.waitForTimeout(500)
  const fixedSupp = await prisma.eventSupplement.findFirstOrThrow({ where: { tenantId: seed.tenantA, roomEventId: roomEvent.id, evidenceRef: 'Supplier notice EVT-FIXED' } })
  check('DB: FIXED supplement stores PER_ROOM/PER_NIGHT and the exact integer minor-unit amount (3000)', fixedSupp.status === 'DRAFT' && fixedSupp.basis === 'PER_ROOM' && fixedSupp.frequency === 'PER_NIGHT' && fixedSupp.amountMinor === 3_000n)

  const activate = async (supp, label) => {
    await withPrompts(page, [`Certification: submit ${label}`], () => supplementRow(page, supp.evidenceRef).getByRole('button', { name: 'Submit' }).click())
    await page.waitForTimeout(400)
    const pending = await prisma.eventSupplement.findUniqueOrThrow({ where: { id: supp.id } })
    const approvalReq = await prisma.approvalRequest.findFirstOrThrow({ where: { tenantId: seed.tenantA, entityType: 'event_supplement', entityId: supp.id, status: 'PENDING' } })
    const self = await page.request.post(`${BASE}/api/v1/admin/event-supplement-approvals/${approvalReq.id}/approve`, { data: { reason: 'self-approval attempt' }, headers: { 'content-type': 'application/json', origin: BASE } })
    check(`${label}: the maker approving their own request is refused (403)`, self.status() === 403, String(self.status()))
    await checker.page.goto(`${BASE}/room-events/${roomEvent.id}`)
    await withPrompts(checker.page, [`Certification: approved ${label}`], () => checker.page.locator(`tr:has-text("${supp.evidenceRef}")`).getByRole('button', { name: 'Approve' }).click())
    await checker.page.waitForTimeout(400)
    check(`${label}: approved by a different person`, (await prisma.eventSupplement.findUniqueOrThrow({ where: { id: supp.id } })).status === 'APPROVED')
    await page.goto(`${BASE}/room-events/${roomEvent.id}`)
    await withPrompts(page, [`Certification: activate ${label}`], () => page.locator(`tr:has-text("${supp.evidenceRef}")`).getByRole('button', { name: 'Activate' }).click())
    await page.waitForTimeout(400)
    const active = await prisma.eventSupplement.findUniqueOrThrow({ where: { id: supp.id } })
    check(`${label}: activation stores ACTIVE with an immutable version snapshot`, active.status === 'ACTIVE' && active.activatedAt !== null)
    check(`${label}: exactly one ACTIVATION version row recorded (CLAUDE.md invariant 8)`, (await prisma.eventSupplementVersion.count({ where: { eventSupplementId: supp.id, kind: 'ACTIVATION' } })) === 1)
    void pending
  }
  await activate(fixedSupp, 'the FIXED supplement')

  // ---- the pricing math itself, in integer minor units, through the real evaluator ----------------------------------------------
  const previewDates = [iso(10), iso(11), iso(12)]
  const preview1 = await page.request.post(`${BASE}/api/v1/admin/event-supplements/preview`, { data: { ratePlanId: seed.planId, stayDates: previewDates, rooms: 1, adults: 2, children: 0 }, headers: { 'content-type': 'application/json', origin: BASE } })
  const p1 = (await preview1.json()).data
  check('Rate Impact Preview: every night carries the FIXED per-room-per-night amount exactly (3000), on the stored contracted base (50000)', p1.nights.every((n) => n.contractedBaseMinor === '50000' && n.eventSupplementMinor === '3000' && n.adjustedNetMinor === '53000'))

  // ---- a second, higher-priority PERCENTAGE supplement: among non-stackable rules the highest priority wins -----------------------
  await page.goto(`${BASE}/room-events/${roomEvent.id}`)
  const supForm2 = page.locator('[aria-label="New event supplement"]')
  await supForm2.getByLabel('Contract id').fill(seed.contractId)
  await supForm2.getByLabel(/Rate plan id/).fill(seed.planId)
  await supForm2.getByLabel('Amount kind').selectOption('PERCENTAGE')
  await supForm2.getByLabel(/Percent/).fill('1000') // 1000 bp = 10% of a round AED 500.00 base: an exact amount, no rounding ambiguity.
  await supForm2.getByLabel('Currency').fill('AED')
  await supForm2.getByLabel('Valid from').fill(iso(5))
  await supForm2.getByLabel('Valid to').fill(iso(40))
  await supForm2.getByLabel('Priority').fill('10')
  await supForm2.getByLabel('Evidence').fill('Supplier notice EVT-PERCENT')
  await supForm2.getByRole('button', { name: 'Create draft' }).click()
  await page.waitForTimeout(500)
  const pctSupp = await prisma.eventSupplement.findFirstOrThrow({ where: { tenantId: seed.tenantA, roomEventId: roomEvent.id, evidenceRef: 'Supplier notice EVT-PERCENT' } })
  check('DB: PERCENTAGE supplement stores percentBp, no FIXED fields', pctSupp.amountKind === 'PERCENTAGE' && pctSupp.percentBp === 1000 && pctSupp.basis === null && pctSupp.amountMinor === null)
  await activate(pctSupp, 'the PERCENTAGE supplement')

  const preview2 = await page.request.post(`${BASE}/api/v1/admin/event-supplements/preview`, { data: { ratePlanId: seed.planId, stayDates: previewDates, rooms: 1, adults: 2, children: 0 }, headers: { 'content-type': 'application/json', origin: BASE } })
  const p2 = (await preview2.json()).data
  check('two non-stackable, overlapping rules: the higher-priority PERCENTAGE one wins outright (5000 = 10% of 50000), the lower-priority FIXED one is excluded', p2.nights.every((n) => n.eventSupplementMinor === '5000' && n.adjustedNetMinor === '55000') && p2.eventSupplements.length === 1 && p2.eventSupplements[0].roomEventName === roomEvent.name)

  // ---- a third, equal-priority non-stackable rule: an eligible tie must fail closed, never pick arbitrarily ----------------------
  await page.goto(`${BASE}/room-events/${roomEvent.id}`)
  const supForm3 = page.locator('[aria-label="New event supplement"]')
  await supForm3.getByLabel('Contract id').fill(seed.contractId)
  await supForm3.getByLabel(/Rate plan id/).fill(seed.planId)
  await supForm3.getByLabel('Amount kind').selectOption('FIXED')
  await supForm3.getByLabel('Basis').selectOption('PER_ROOM')
  await supForm3.getByLabel('Frequency').selectOption('PER_NIGHT')
  await supForm3.getByLabel(/Amount \(minor units\)/).fill('1500')
  await supForm3.getByLabel('Currency').fill('AED')
  await supForm3.getByLabel('Valid from').fill(iso(5))
  await supForm3.getByLabel('Valid to').fill(iso(40))
  await supForm3.getByLabel('Priority').fill('10') // ties the PERCENTAGE rule's priority
  await supForm3.getByLabel('Evidence').fill('Supplier notice EVT-TIE')
  await supForm3.getByRole('button', { name: 'Create draft' }).click()
  await page.waitForTimeout(500)
  const tieSupp = await prisma.eventSupplement.findFirstOrThrow({ where: { tenantId: seed.tenantA, roomEventId: roomEvent.id, evidenceRef: 'Supplier notice EVT-TIE' } })
  await activate(tieSupp, 'the tied-priority supplement')
  const preview3 = await page.request.post(`${BASE}/api/v1/admin/event-supplements/preview`, { data: { ratePlanId: seed.planId, stayDates: previewDates, rooms: 1, adults: 2, children: 0 }, headers: { 'content-type': 'application/json', origin: BASE } })
  const body3 = await preview3.json()
  check('an eligible tie between two non-stackable rules at the same priority fails closed (409 EVENT_SUPPLEMENT_CONFLICT), never picks one arbitrarily', preview3.status() === 409 && /EVENT_SUPPLEMENT_CONFLICT/.test(JSON.stringify(body3)))

  await withPrompts(page, ['Certification: resolve the tie by suspending the duplicate'], () => page.locator(`tr:has-text("${tieSupp.evidenceRef}")`).getByRole('button', { name: 'Suspend' }).click())
  await page.waitForTimeout(400)
  check('suspending the tied rule removes it from pricing', (await prisma.eventSupplement.findUniqueOrThrow({ where: { id: tieSupp.id } })).status === 'SUSPENDED')
  const preview4 = await page.request.post(`${BASE}/api/v1/admin/event-supplements/preview`, { data: { ratePlanId: seed.planId, stayDates: previewDates, rooms: 1, adults: 2, children: 0 }, headers: { 'content-type': 'application/json', origin: BASE } })
  check('after suspending the duplicate, pricing succeeds again with the remaining (higher-priority) rule', preview4.status() === 200)

  // ---- maker-checker amendment: changes the terms only after a second person approves exactly what will be applied -------------
  // Filed directly against the API: by this point the supplement already carries a decided (EXECUTED) approval, and the "Request
  // amendment" button in this build of the Admin UI is gated on having NO approval at all, ever — not on having no OPEN one — so it
  // never reappears after the first activation. Worth a human's attention; out of scope for this certification script to fix.
  const amendReq = await page.request.post(`${BASE}/api/v1/admin/event-supplements/${pctSupp.id}/amendment-request`, { data: { changes: { percentBp: 2000 }, reason: 'Certification: raise the percentage, needs review' }, headers: { 'content-type': 'application/json', origin: BASE } })
  check('the amendment request is filed against the real API', amendReq.status() === 201 || amendReq.status() === 200, String(amendReq.status()))
  const amendApproval = await prisma.approvalRequest.findFirstOrThrow({ where: { tenantId: seed.tenantA, entityType: 'event_supplement', entityId: pctSupp.id, status: 'PENDING' } })
  check('the amendment is filed but applies nothing until approved and executed', (await prisma.eventSupplement.findUniqueOrThrow({ where: { id: pctSupp.id } })).percentBp === 1000)
  await checker.page.goto(`${BASE}/room-events/${roomEvent.id}`)
  await withPrompts(checker.page, ['Reviewed and approved: raising to 20%'], () => checker.page.locator(`tr:has-text("${pctSupp.evidenceRef}")`).getByRole('button', { name: 'Approve' }).click())
  await checker.page.waitForTimeout(400)
  check('amendment approval alone still applies nothing (execute is a separate, deliberate step)', (await prisma.eventSupplement.findUniqueOrThrow({ where: { id: pctSupp.id } })).percentBp === 1000)
  await page.goto(`${BASE}/room-events/${roomEvent.id}`)
  await withPrompts(page, ['Certification: apply the approved amendment'], () => page.locator(`tr:has-text("${pctSupp.evidenceRef}")`).getByRole('button', { name: 'Execute amendment' }).click())
  await page.waitForTimeout(400)
  const amended = await prisma.eventSupplement.findUniqueOrThrow({ where: { id: pctSupp.id } })
  check('executing the approved amendment applies exactly the reviewed change and bumps the version', amended.percentBp === 2000 && amended.version === 2)
  check('exactly one AMENDMENT version row recorded, bound to the approval', (await prisma.eventSupplementVersion.count({ where: { eventSupplementId: pctSupp.id, kind: 'AMENDMENT', approvalId: amendApproval.id } })) === 1)

  // ---- tenant isolation: tenant B cannot preview, read or decide against tenant A's event or supplements --------------------------
  const b = await login(browser, seed.bownerEmail)
  const crossPreview = await b.page.request.post(`${BASE}/api/v1/admin/event-supplements/preview`, { data: { ratePlanId: seed.planId, stayDates: previewDates, rooms: 1, adults: 2, children: 0 }, headers: { 'content-type': 'application/json', origin: BASE } })
  check("tenant B cannot price against tenant A's rate plan (not found, never another tenant's price)", crossPreview.status() === 404, String(crossPreview.status()))
  const crossGetEvent = await b.page.request.get(`${BASE}/api/v1/admin/room-events/${roomEvent.id}`)
  check("tenant B cannot read tenant A's Room Event", crossGetEvent.status() === 404, String(crossGetEvent.status()))
  const crossApprove = await b.page.request.post(`${BASE}/api/v1/admin/event-supplement-approvals/${amendApproval.id}/approve`, { data: { reason: 'cross-tenant attempt' }, headers: { 'content-type': 'application/json', origin: BASE } })
  check("tenant B cannot decide tenant A's approval request", crossApprove.status() !== 200, String(crossApprove.status()))
  await b.ctx.close()

  // ---- permission boundary: a read-only viewer cannot create a Room Event, even directly --------------------------------------
  const viewer = await login(browser, seed.viewerEmail)
  const viewerCreate = await viewer.page.request.post(`${BASE}/api/v1/admin/room-events`, { data: { name: 'Should not exist', eventType: 'EXHIBITION', destinationCity: 'Dubai', destinationCountry: 'AE', eventStartDate: iso(50), eventEndDate: iso(52) }, headers: { 'content-type': 'application/json', origin: BASE } })
  check('a viewer without supply.room_events.manage is refused (403), nothing created', viewerCreate.status() === 403, String(viewerCreate.status()))
  check('no Room Event named "Should not exist" was created', (await prisma.roomEvent.count({ where: { tenantId: seed.tenantA, name: 'Should not exist' } })) === 0)
  await viewer.ctx.close()

  check('no uncaught page errors', errors.length === 0, errors.join(' | '))
  await maker.ctx.close(); await checker.ctx.close()
  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) { console.log('FAILED:\n' + failed.map((f) => ' - ' + f.name).join('\n')); process.exit(1) }
  await prisma.$disconnect()
})().catch(async (e) => { console.error('FAIL  aborted:', String(e.message ?? e).split('\n')[0]); await prisma.$disconnect().catch(() => {}); process.exit(1) })
