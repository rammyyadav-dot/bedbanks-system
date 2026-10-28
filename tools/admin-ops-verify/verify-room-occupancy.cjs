// Real-stack browser + API verification of room occupancy rules (ADR 0021 stage 2) and extra-bed/child-supplement pricing (ADR 0057 S6
// / ADR 0067 F-03). "Extra bed" is NOT a priced room feature in this codebase: RoomBedding.extraBed (Supported/Not supported/Not
// recorded) is descriptive only, carries no price, and is shown read-only; the money is Contract.ChildPolicy's age-banded
// extraBedAllowed + supplementMinor, applied through the guest-pricing evaluator. This script certifies both, and checks the
// supplement's exact integer-minor-unit math against real DB rows through the rate-certification simulator (the one evaluator Agent
// search also uses). Needs: real PostgreSQL (DATABASE_URL = owner connection), the API process and the production Admin build (see
// README.md), and `seed-room-occupancy.ts` run first on a DISPOSABLE database. Re-seed before every run. Not run in CI.
const path = require('path')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const apiReq = createRequire(path.join(__dirname, '../../apps/api/package.json'))
const { PrismaClient } = apiReq('@prisma/client')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-room-occupancy.json'))
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

;(async () => {
  const browser = await chromium.launch()
  const owner = await login(browser, seed.ownerEmail)
  const { page } = owner
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  let lastRoomCreateBody = null
  page.on('request', (r) => { if (new URL(r.url()).pathname.endsWith(`/hotels/${seed.hotelId}/rooms`) && r.method() === 'POST') { try { lastRoomCreateBody = JSON.parse(r.postData()) } catch { /* ignore */ } } })

  // ---- room occupancy rules: the canonical rule (maxOccupancy >= maxAdults + maxChildren) is enforced, never bypassed by the UI ----
  await page.goto(`${BASE}/hotels/${seed.hotelId}?tab=rooms`)
  await page.waitForSelector('[data-testid=rooms-empty], table[aria-label="Rooms"]')
  await page.getByRole('button', { name: '+ Add room' }).click()
  await page.waitForSelector('[data-testid=room-editor]')
  await page.getByLabel('Room name').fill('Suite Room')
  await page.getByLabel('Room code').fill(`STE-${Date.now().toString(36)}`)
  await page.getByLabel('Max adults').fill('2')
  await page.getByLabel('Max children').fill('2')
  await page.getByLabel('Max total occupancy').fill('2') // invalid: 2 adults + 2 children = 4 > 2
  await page.getByTestId('room-save').click()
  await page.waitForSelector('[data-testid=room-error]', { timeout: 10000 })
  const occError = await page.getByTestId('room-error').innerText()
  check('an occupancy triple that cannot hold its own adults and children is refused, not silently accepted', /maxOccupancy: must be at least maxAdults plus maxChildren/.test(occError), occError)
  check('the refused room was not created', (await prisma.roomType.count({ where: { hotelId: seed.hotelId, name: 'Suite Room' } })) === 0)

  await page.getByLabel('Max children').fill('1')
  await page.getByLabel('Max total occupancy').fill('3')
  await page.getByLabel('Extra bed').selectOption({ label: 'Supported' })
  await page.getByTestId('room-save').click()
  await page.waitForSelector('[data-testid=rooms-flash]', { timeout: 10000 })
  const newRoom = await prisma.roomType.findFirstOrThrow({ where: { hotelId: seed.hotelId, name: 'Suite Room' } })
  check('a valid occupancy triple (2 adults + 1 child = 3) is accepted and stored exactly', newRoom.maxAdults === 2 && newRoom.maxChildren === 1 && newRoom.maxOccupancy === 3)
  check("extra bed is recorded as descriptive metadata (SUPPORTED), not as a priced room field", newRoom.beddingMetadata.extraBed === 'SUPPORTED')
  check('extra bed support carries no price anywhere on the room record (CLAUDE.md invariant 10: never present a placeholder as a priced capability)', !('amountMinor' in newRoom) && !('priceMinor' in newRoom) && !/\d/.test(JSON.stringify(newRoom.beddingMetadata).replace(/"(SUPPORTED|NOT_SUPPORTED|UNKNOWN)"/, '')))
  const roomAudit = await prisma.auditEvent.findMany({ where: { tenantId: seed.tenantA, entityType: 'room_type', entityId: newRoom.id, action: 'hotel.room.created' } })
  check('room creation left exactly one audit event', roomAudit.length === 1)

  // ---- idempotent room creation: replaying the exact create request never makes a second room -------------------------------
  check('captured the real room-create request to replay', lastRoomCreateBody !== null)
  const replay = await page.request.post(`${BASE}/api/v1/admin/hotels/${seed.hotelId}/rooms`, { data: lastRoomCreateBody, headers: { 'content-type': 'application/json', origin: BASE } })
  const replayBody = await replay.json()
  check('replaying the same idempotencyKey returns replayed:true for the same room, not a second one', replay.status() === 201 && replayBody.data.replayed === true && replayBody.data.room.id === newRoom.id)
  check('exactly one room with this name/code exists after the replay', (await prisma.roomType.count({ where: { hotelId: seed.hotelId, name: 'Suite Room' } })) === 1)

  // ---- extra-bed / child-supplement pricing: created via the contract policy editor on a DRAFT (editable) contract --------------
  await page.goto(`${BASE}/contracts/${seed.contract2Id}`)
  await page.waitForSelector('section[aria-label="Commercial policies"]')
  const childForm = page.locator('form', { has: page.getByLabel('Minimum age') })
  await page.getByLabel('Minimum age').fill('2')
  await page.getByLabel('Maximum age').fill('12')
  await page.getByLabel(/^Supplement per child/).fill('50.00')
  await page.getByLabel('Extra bed allowed').check()
  await childForm.getByRole('button', { name: 'Add child band' }).click()
  await page.waitForTimeout(400)
  const band1 = await prisma.childPolicy.findFirstOrThrow({ where: { contractId: seed.contract2Id } })
  check('UI create: the child band stores extraBedAllowed and the supplement in exact integer minor units (AED 50.00 -> 5000)', band1.minAge === 2 && band1.maxAge === 12 && band1.extraBedAllowed === true && band1.supplementMinor === 5_000n)

  await page.getByLabel('Minimum age').fill('10')
  await page.getByLabel('Maximum age').fill('15')
  await page.getByLabel(/^Supplement per child/).fill('30.00')
  await childForm.getByRole('button', { name: 'Add child band' }).click()
  await page.waitForTimeout(400)
  check('an overlapping child-age band (10-15 over an existing 2-12) is refused, not stored as a silent second price', (await prisma.childPolicy.count({ where: { contractId: seed.contract2Id } })) === 1)

  const badAge = await page.request.post(`${BASE}/api/v1/supply/contracts/${seed.contract2Id}/policies/child`, { data: { minAge: 5, maxAge: 25, extraBedAllowed: false, supplementMinor: '1000', currency: 'AED' }, headers: { 'content-type': 'application/json', origin: BASE } })
  check('a child band above age 17 is refused by the API directly, never only by the client form', badAge.status() === 400, String(badAge.status()))
  check('the refused age band was not stored', (await prisma.childPolicy.count({ where: { contractId: seed.contract2Id, maxAge: 25 } })) === 0)

  // ---- cross-tenant: tenant B cannot add a child band to tenant A's contract ----------------------------------------------------
  const b = await login(browser, seed.bownerEmail)
  const crossStatus = (await b.page.request.post(`${BASE}/api/v1/supply/contracts/${seed.contract2Id}/policies/child`, { data: { minAge: 0, maxAge: 5, extraBedAllowed: false, supplementMinor: '1000', currency: 'AED' }, headers: { 'content-type': 'application/json', origin: BASE } })).status()
  check("tenant B cannot create a child band on tenant A's contract (not found, never leaked)", crossStatus === 404, String(crossStatus))
  await b.ctx.close()

  // ---- the pricing math itself: the stored child supplement, checked in integer minor units through the real evaluator ----------
  await page.goto(`${BASE}/rate-certification?tab=simulator&ratePlanId=${encodeURIComponent(seed.planId)}`)
  await page.waitForSelector('[data-testid=simulator]')
  const form = page.locator('form[aria-label="Price simulator"]')
  await form.getByLabel('Rate plan ID').fill(seed.planId)
  await form.getByLabel('Check-in').fill(iso(5))
  await form.getByLabel('Check-out').fill(iso(8))
  await form.getByLabel('Adults').fill('2')
  await form.getByLabel('Children').fill('1')
  await form.getByLabel('Child ages').fill('8') // covered by the contract's 2-12 band
  await form.getByLabel('Rooms').fill('1')
  await page.getByRole('button', { name: 'Simulate' }).click()
  await page.waitForSelector('[data-testid=simulation-result]', { timeout: 15000 })
  const eligible1 = await page.getByTestId('simulation-result').getAttribute('data-eligible')
  const totalText1 = await page.getByTestId('simulation-total').innerText()
  const dbRate = await prisma.dailyRate.findFirstOrThrow({ where: { tenantId: seed.tenantA, ratePlanId: seed.planId, stayDate: new Date(`${iso(5)}T00:00:00.000Z`), occupancy: 2 } })
  const dbBand = await prisma.childPolicy.findFirstOrThrow({ where: { contractId: seed.contract1Id } })
  const expectedTotal = (dbRate.amountMinor + dbBand.supplementMinor) * 3n // 3 nights, 1 room, SELL basis so no markup
  check('a covered child age is eligible and the total matches the stored rate plus the stored child supplement exactly, in integer minor units', eligible1 === 'true' && totalText1.replace(/[^0-9.]/g, '').replace('.', '') === expectedTotal.toString())
  const reconciles1 = await page.locator('[data-testid=simulation-result]').innerText()
  check('the evaluator total reconciles with an independent per-night recomputation', /RECONCILES/.test(reconciles1))

  await form.getByLabel('Child ages').fill('15') // outside every band on this contract
  await page.getByRole('button', { name: 'Simulate' }).click()
  await page.waitForSelector('[data-testid=simulation-result]', { timeout: 15000 })
  const eligible2 = await page.getByTestId('simulation-result').getAttribute('data-eligible')
  const reasons2 = await page.getByTestId('simulation-reasons').innerText().catch(() => '')
  check('a child age with no covering band makes the stay unsellable, never priced at zero or guessed', eligible2 === 'false' && /CHILD_AGE_NOT_COVERED/.test(reasons2), reasons2)

  // ---- tenant isolation on the room surface --------------------------------------------------------------------------------------
  const b2 = await login(browser, seed.bownerEmail)
  const crossRoomList = await b2.page.request.get(`${BASE}/api/v1/admin/hotels/${seed.hotelId}/rooms`)
  check("tenant B cannot list tenant A's rooms (not found, never another tenant's room list)", crossRoomList.status() === 404, String(crossRoomList.status()))
  await b2.ctx.close()

  // ---- permission boundary: a read-only viewer cannot create a room, even directly ----------------------------------------------
  const viewer = await login(browser, seed.viewerEmail)
  const viewerCreate = await viewer.page.request.post(`${BASE}/api/v1/admin/hotels/${seed.hotelId}/rooms`, { data: { idempotencyKey: `viewer-${Date.now().toString(36)}`, name: 'Should not exist', code: `NOPE-${Date.now().toString(36)}`, maxAdults: 1, maxChildren: 0, maxOccupancy: 1 }, headers: { 'content-type': 'application/json', origin: BASE } })
  check('a viewer without supply.rooms.manage is refused (403), nothing created', viewerCreate.status() === 403, String(viewerCreate.status()))
  check('no room named "Should not exist" was created', (await prisma.roomType.count({ where: { hotelId: seed.hotelId, name: 'Should not exist' } })) === 0)
  await viewer.ctx.close()

  check('no uncaught page errors', errors.length === 0, errors.join(' | '))
  await owner.ctx.close()
  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) { console.log('FAILED:\n' + failed.map((f) => ' - ' + f.name).join('\n')); process.exit(1) }
  await prisma.$disconnect()
})().catch(async (e) => { console.error('FAIL  aborted:', String(e.message ?? e).split('\n')[0]); await prisma.$disconnect().catch(() => {}); process.exit(1) })
