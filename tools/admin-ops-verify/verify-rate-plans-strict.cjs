// Real-stack browser verification of the Rate Plans tab against an API that connects as the STRICT runtime login (ADR 0041 Amendment 3, issue 304).
// Needs: API on the strict role + production Admin build + `seed-hotels.ts` (disposable database only). Re-seed before every run. Not run in CI.
//   LIFECYCLE_ROLE=configured  API started with RATE_PLAN_OPS_DATABASE_URL: Activate/Suspend work, Clone is disabled and explained.
//   LIFECYCLE_ROLE=absent      API started without it: all three controls are disabled and explained; nothing is sent to the API.
// DATABASE_URL here is the OWNER connection, used only to arrange fixtures and read back results; the browser acts through the UI.
const path = require('path')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const apiReq = createRequire(path.join(__dirname, '../../apps/api/package.json'))
const { PrismaClient } = apiReq('@prisma/client')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-hotels.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const MODE = process.env.LIFECYCLE_ROLE === 'absent' ? 'absent' : 'configured'
const prisma = new PrismaClient()
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`) }
const DAY = 86_400_000
const utc = (offset) => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime() + offset * DAY
const row = (page, code) => page.locator('tr[data-plan-id]').filter({ has: page.locator(`code:text-is("${code}")`) })

;(async () => {
  const hotelId = seed.hotels.alpha
  const template = await prisma.ratePlan.findFirstOrThrow({ where: { roomType: { hotelId }, status: 'ACTIVE' } })
  const tag = Date.now().toString(36)
  const ready = await prisma.ratePlan.create({ data: { tenantId: template.tenantId, contractId: template.contractId, roomTypeId: template.roomTypeId, boardBasisId: template.boardBasisId, code: `ST-READY-${tag}`, status: 'DRAFT', occupancy: 2, currency: 'AED', refundable: false } })
  const range = Array.from({ length: 40 }, (_, i) => new Date(utc(-1 + i)))
  await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId: ready.tenantId, ratePlanId: ready.id, stayDate, occupancy: 2, amountMinor: 52_500n, currency: 'AED', amountBasis: 'SELL' })) })
  await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId: ready.tenantId, ratePlanId: ready.id, stayDate, allotment: 5 })) })

  const browser = await chromium.launch()
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  const lifecycleCalls = []; page.on('request', (r) => { if (/\/supply\/rate-plans\/[^/]+\/(activate|suspend|clone)$/.test(r.url()) && r.method() === 'POST') lifecycleCalls.push(r.url()) })
  await page.goto(`${BASE}/login`); await page.fill('#email', seed.ownerEmail); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  const api = async (p) => (await (await page.request.get(`${BASE}${p}`)).json())

  const caps = (await api('/api/v1/supply/rate-plans/capabilities')).data
  check(`capabilities API (${MODE}): clone is unavailable with STRICT_ROLE_NO_WRITER`, caps.clone.available === false && caps.clone.reason === 'STRICT_ROLE_NO_WRITER', JSON.stringify(caps))
  check(`capabilities API (${MODE}): activate and suspend ${MODE === 'configured' ? 'available' : 'unavailable with LIFECYCLE_ROLE_NOT_PROVISIONED'}`, MODE === 'configured' ? caps.activate.available && caps.suspend.available : !caps.activate.available && caps.activate.reason === 'LIFECYCLE_ROLE_NOT_PROVISIONED' && !caps.suspend.available)

  await page.goto(`${BASE}/hotels/${hotelId}?tab=rateplans`); await page.waitForSelector('table[aria-label="Rate plans"]', { timeout: 20000 })
  await page.locator('[data-testid=capability-notice]').waitFor({ timeout: 10000 })
  const notice = await page.locator('[data-testid=capability-notice]').innerText()
  check('the tab explains why Clone is unavailable and points to Create Rate Plan', /Clone is not available in this environment/.test(notice) && /Create Rate Plan/.test(notice), notice)
  check(`the tab ${MODE === 'configured' ? 'does not claim' : 'explains that'} the lifecycle role is missing`, MODE === 'configured' ? !/lifecycle database role is not provisioned/.test(notice) : /lifecycle database role is not provisioned/.test(notice), notice)

  const cloneBtn = row(page, ready.code).getByRole('button', { name: /^Clone/ })
  check('Clone is disabled on every row, with the reason as its tooltip', (await cloneBtn.isDisabled()) && /not available in this environment/.test((await cloneBtn.getAttribute('title')) ?? '') && (await page.locator('tr[data-plan-id] button[data-unavailable=true]:has-text("Clone")').count()) === (await page.locator('tr[data-plan-id]').count()))
  await cloneBtn.click({ force: true, trial: false }).catch(() => undefined)
  check('clicking a disabled Clone opens nothing and sends nothing', (await page.locator('section[aria-label^="clone"]').count()) === 0 && !lifecycleCalls.some((u) => u.endsWith('/clone')))
  const direct = await page.request.post(`${BASE}/api/v1/supply/rate-plans/${ready.id}/clone`, { data: { code: `ST-CLONE-${tag}` }, headers: { 'content-type': 'application/json', origin: BASE } })
  const directBody = await direct.json().catch(() => ({}))
  check('the database stays the authority: a direct clone call is a typed 403 and creates nothing', direct.status() === 403 && directBody.error?.code === 'RUNTIME_ROLE_OPERATION_PROHIBITED' && (await prisma.ratePlan.count({ where: { code: `ST-CLONE-${tag}` } })) === 0, `${direct.status()} ${directBody.error?.code}`)

  const activateBtn = row(page, ready.code).getByRole('button', { name: /^Activate/ })
  if (MODE === 'configured') {
    check('Activate is enabled when the lifecycle role is configured', await activateBtn.isEnabled())
    await activateBtn.click(); await page.waitForSelector('[data-testid=readiness-checklist]')
    await page.getByRole('button', { name: 'Confirm activation' }).click()
    await page.waitForFunction(([code]) => [...document.querySelectorAll('tr[data-plan-id]')].some((tr) => tr.textContent.includes(code) && tr.getAttribute('data-status') === 'ACTIVE'), [ready.code], { timeout: 15000 })
    check('activation through the UI succeeds on the strict login (via the lifecycle role)', (await prisma.ratePlan.findUniqueOrThrow({ where: { id: ready.id } })).status === 'ACTIVE')
    const audit = await prisma.auditEvent.findMany({ where: { entityId: ready.id, action: 'supply.rate_plan.status_changed' } })
    check('exactly one status audit event, DRAFT to ACTIVE', audit.length === 1 && audit[0].payload.before.status === 'DRAFT' && audit[0].payload.after.status === 'ACTIVE')
    await row(page, ready.code).getByRole('button', { name: /^Suspend/ }).click(); await page.getByLabel('Suspension reason').fill('Strict-role browser verification')
    await page.getByRole('button', { name: 'Confirm suspension' }).click()
    await page.waitForFunction(([code]) => [...document.querySelectorAll('tr[data-plan-id]')].some((tr) => tr.textContent.includes(code) && tr.getAttribute('data-status') === 'SUSPENDED'), [ready.code], { timeout: 15000 })
    check('suspension through the UI succeeds on the strict login', (await prisma.ratePlan.findUniqueOrThrow({ where: { id: ready.id } })).status === 'SUSPENDED')
  } else {
    check('Activate is disabled with the lifecycle-role explanation', (await activateBtn.isDisabled()) && /lifecycle database role is not provisioned/.test((await activateBtn.getAttribute('title')) ?? ''))
    await activateBtn.click({ force: true }).catch(() => undefined)
    check('clicking a disabled Activate sends nothing and the plan stays DRAFT', lifecycleCalls.length === 0 && (await prisma.ratePlan.findUniqueOrThrow({ where: { id: ready.id } })).status === 'DRAFT')
    const direct2 = await page.request.post(`${BASE}/api/v1/supply/rate-plans/${ready.id}/activate`, { data: { expectedUpdatedAt: (await api(`/api/v1/supply/rate-plans/${ready.id}/readiness`)).data.updatedAt }, headers: { 'content-type': 'application/json', origin: BASE } })
    const b2 = await direct2.json().catch(() => ({}))
    check('the database stays the authority: a direct activate is a typed 403 and the plan stays DRAFT', direct2.status() === 403 && b2.error?.code === 'RUNTIME_ROLE_OPERATION_PROHIBITED' && (await prisma.ratePlan.findUniqueOrThrow({ where: { id: ready.id } })).status === 'DRAFT')
  }
  check('no uncaught page errors', errors.length === 0, errors.join(' | '))

  await browser.close(); await prisma.$disconnect()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error('FAIL  aborted:', String(e.message ?? e).split('\n')[0]); process.exit(1) })
