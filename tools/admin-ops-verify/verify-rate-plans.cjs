// Real-stack browser verification of the hotel Rate Plans tab (ADR 0041). See README.md. Not run in CI.
// Needs: API + production Admin build + `seed-hotels.ts` (disposable database only). Re-seed before every run.
const path = require('path')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const AxeBuilder = req('@axe-core/playwright').default || req('@axe-core/playwright')
const apiReq = createRequire(path.join(__dirname, '../../apps/api/package.json'))
const { PrismaClient } = apiReq('@prisma/client')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-hotels.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const SHOTS = process.env.SHOT_DIR ?? require('os').tmpdir()
const prisma = new PrismaClient()
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 200) : ''}`) }
const DAY = 86_400_000
const utc = (offset) => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime() + offset * DAY

async function login(browser, email, viewport) {
  const ctx = await browser.newContext(viewport ? { viewport } : {}); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
const row = (page, code) => page.locator(`tr[data-plan-id]`).filter({ has: page.locator(`code:text-is("${code}")`) })
const status = async (page, code) => row(page, code).getAttribute('data-status')

;(async () => {
  const hotelId = seed.hotels.alpha
  // ---- arrange: three extra plans on a seeded, ready hotel (owner connection; the browser only reads and acts through the UI) ----
  const template = await prisma.ratePlan.findFirstOrThrow({ where: { roomType: { hotelId }, status: 'ACTIVE' }, include: { roomType: true } })
  const tag = Date.now().toString(36)
  const mk = async (code, st, complete) => {
    const p = await prisma.ratePlan.create({ data: { tenantId: template.tenantId, contractId: template.contractId, roomTypeId: template.roomTypeId, boardBasisId: template.boardBasisId, code, status: st, occupancy: 2, currency: 'AED', refundable: false } })
    if (complete) {
      const range = Array.from({ length: 40 }, (_, i) => new Date(utc(-1 + i)))
      await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId: p.tenantId, ratePlanId: p.id, stayDate, occupancy: 2, amountMinor: 52_500n, currency: 'AED', amountBasis: 'SELL' })) })
      await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId: p.tenantId, ratePlanId: p.id, stayDate, allotment: 5 })) })
    }
    return p
  }
  const ready = await mk(`BR-READY-${tag}`, 'DRAFT', true)
  const bare = await mk(`BR-BARE-${tag}`, 'DRAFT', false)
  const susp = await mk(`BR-SUSP-${tag}`, 'SUSPENDED', true)

  const browser = await chromium.launch()
  const { ctx, page } = await login(browser, seed.ownerEmail)
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  const planApi = async (p) => (await (await page.request.get(`${BASE}${p}`)).json())
  const open = async () => { await page.goto(`${BASE}/hotels/${hotelId}?tab=rateplans`); await page.waitForSelector('table[aria-label="Rate plans"]', { timeout: 20000 }) }

  // 1. tab present, loads, counts equal the API's
  await page.goto(`${BASE}/hotels/${hotelId}`); await page.waitForSelector('[data-testid=hotel-header]', { timeout: 20000 })
  check('Rate Plans tab is in the hotel tab list', (await page.getByRole('tab', { name: 'Rate Plans', exact: true }).count()) === 1)
  await page.getByRole('tab', { name: 'Rate Plans', exact: true }).click(); await page.waitForSelector('table[aria-label="Rate plans"]')
  const counts = (await planApi(`/api/v1/supply/rate-plan-portfolio?hotelId=${hotelId}&page=1&pageSize=1`)).data.statusCounts
  const toolbar = async () => (await page.locator('[data-testid=plan-counts]').innerText()).replace(/\s+/g, ' ')
  const parse = (t) => ({ total: Number((t.match(/(\d+) rate plans/) ?? [])[1]), active: Number((t.match(/(\d+) active/) ?? [])[1]), draft: Number((t.match(/(\d+) draft/) ?? [])[1]), suspended: Number((t.match(/(\d+) suspended/) ?? [])[1]) })
  let t0 = parse(await toolbar())
  check('toolbar counts equal the API status counts', t0.total === Object.values(counts).reduce((a, b) => a + b, 0) && t0.active === counts.ACTIVE && t0.draft === counts.DRAFT && t0.suspended === counts.SUSPENDED, JSON.stringify({ t0, counts }))
  check('grid lists the three new plans with the right status', (await status(page, ready.code)) === 'DRAFT' && (await status(page, bare.code)) === 'DRAFT' && (await status(page, susp.code)) === 'SUSPENDED')
  await page.screenshot({ path: `${SHOTS}/rate-plans-tab.png`, fullPage: true })

  // 2. filter + search
  await page.getByLabel('Filter by status').selectOption('SUSPENDED'); await page.waitForTimeout(600)
  const onlySuspended = await page.locator('tr[data-plan-id]').evaluateAll((trs) => trs.every((tr) => tr.getAttribute('data-status') === 'SUSPENDED'))
  check('status filter shows only suspended plans', onlySuspended && (await row(page, susp.code).count()) === 1)
  await page.getByLabel('Filter by status').selectOption(''); await page.getByLabel('Search rate plans by code').fill(`BR-BARE-${tag}`); await page.waitForTimeout(700)
  check('code search narrows to one plan', (await page.locator('tr[data-plan-id]').count()) === 1)
  await page.getByLabel('Search rate plans by code').fill(''); await page.waitForTimeout(600)

  // 3. failed activation: checklist equals the API's, confirm disabled, nothing changes
  await row(page, bare.code).getByRole('button', { name: 'Activate' }).click(); await page.waitForSelector('[data-testid=readiness-checklist]')
  const shown = await page.locator('[data-testid=readiness-checklist] li').evaluateAll((lis) => lis.map((li) => [li.getAttribute('data-check'), li.getAttribute('data-ok') === 'true']))
  const apiChecks = (await planApi(`/api/v1/supply/rate-plans/${bare.id}/readiness`)).data.checks.map((c) => [c.code, c.ok])
  check('checklist in the UI equals the API readiness verdict, check by check', JSON.stringify(shown) === JSON.stringify(apiChecks), `${shown.length} vs ${apiChecks.length}`)
  const failedText = (await page.locator('[data-testid=readiness-checklist] li[data-ok=false]').allInnerTexts()).join(' | ')
  check('failed checks carry actionable text (rates and inventory)', /No rate exists/.test(failedText) && /availability row/.test(failedText), failedText.slice(0, 160))
  check('confirm activation is disabled while a check fails', await page.getByRole('button', { name: 'Confirm activation' }).isDisabled())
  await page.getByRole('button', { name: 'Cancel' }).click()
  check('a refused plan stays DRAFT in the database', (await prisma.ratePlan.findUniqueOrThrow({ where: { id: bare.id } })).status === 'DRAFT')

  // 4. successful activation refreshes status and counts
  t0 = parse(await toolbar())
  await row(page, ready.code).getByRole('button', { name: 'Activate' }).click(); await page.waitForSelector('[data-testid=readiness-checklist]')
  const allPass = await page.locator('[data-testid=readiness-checklist] li').evaluateAll((lis) => lis.every((li) => li.getAttribute('data-ok') === 'true'))
  check('a ready plan shows an all-PASS checklist', allPass)
  await page.getByRole('button', { name: 'Confirm activation' }).click()
  await page.waitForFunction(([code]) => [...document.querySelectorAll('tr[data-plan-id]')].some((tr) => tr.textContent.includes(code) && tr.getAttribute('data-status') === 'ACTIVE'), [ready.code], { timeout: 15000 })
  const t1 = parse(await toolbar())
  check('activation updates the row status', (await status(page, ready.code)) === 'ACTIVE')
  check('activation updates the counts (active +1, draft -1)', t1.active === t0.active + 1 && t1.draft === t0.draft - 1, JSON.stringify({ t0, t1 }))
  const audit = await prisma.auditEvent.findMany({ where: { entityId: ready.id, action: 'supply.rate_plan.status_changed' } })
  check('exactly one status audit event, DRAFT to ACTIVE', audit.length === 1 && audit[0].payload.before.status === 'DRAFT' && audit[0].payload.after.status === 'ACTIVE')

  // 5. suspend requires a reason
  await row(page, ready.code).getByRole('button', { name: 'Suspend' }).click(); await page.getByLabel('Suspension reason').waitFor()
  check('suspend is disabled without a reason', await page.getByRole('button', { name: 'Confirm suspension' }).isDisabled())
  await page.getByLabel('Suspension reason').fill('Browser verification'); await page.getByRole('button', { name: 'Confirm suspension' }).click()
  await page.waitForFunction(([code]) => [...document.querySelectorAll('tr[data-plan-id]')].some((tr) => tr.textContent.includes(code) && tr.getAttribute('data-status') === 'SUSPENDED'), [ready.code], { timeout: 15000 })
  check('suspension updates the row status', (await status(page, ready.code)) === 'SUSPENDED')
  const sAudit = await prisma.auditEvent.findFirst({ where: { entityId: ready.id, action: 'supply.rate_plan.status_changed' }, orderBy: { createdAt: 'desc' } })
  check('suspension audit carries the reason', sAudit?.payload?.reason === 'Browser verification')

  // 6. stale version: the plan changes between opening the dialog and confirming
  await row(page, susp.code).getByRole('button', { name: 'Activate' }).click(); await page.waitForSelector('[data-testid=readiness-checklist]')
  await prisma.ratePlan.update({ where: { id: susp.id }, data: { minStay: 2 } })
  await page.getByRole('button', { name: 'Confirm activation' }).click(); const dialogAlert = page.locator('section[aria-label^="activate"] [role=alert]'); await dialogAlert.waitFor({ timeout: 10000 })
  const alert = await dialogAlert.innerText()
  check('a stale activation shows an actionable error and changes nothing', /changed|reload/i.test(alert) && (await prisma.ratePlan.findUniqueOrThrow({ where: { id: susp.id } })).status === 'SUSPENDED', alert)
  await page.getByRole('button', { name: 'Cancel' }).click()

  // 7. clone is a draft and never active
  await row(page, bare.code).getByRole('button', { name: 'Clone' }).click()
  await page.getByLabel('New rate plan code').fill(`BR-CLONE-${tag}`); await page.getByRole('button', { name: 'Create draft clone' }).click()
  await page.waitForFunction(([code]) => [...document.querySelectorAll('tr[data-plan-id]')].some((tr) => tr.textContent.includes(code)), [`BR-CLONE-${tag}`], { timeout: 15000 })
  check('a clone appears as DRAFT', (await status(page, `BR-CLONE-${tag}`)) === 'DRAFT')

  // 8. adjacent screens still work; the rate plan form no longer edits status
  await page.goto(`${BASE}/hotels/${hotelId}?tab=rates`); await page.waitForSelector('[data-testid=calendar]', { timeout: 20000 })
  check('Rates & Inventory calendar still renders', (await page.locator('[data-testid=calendar] table').count()) > 0)
  await page.goto(`${BASE}/hotels/${hotelId}?tab=quick`); await page.waitForTimeout(1500)
  check('Quick Update tab still renders', /Quick Update|Preview|Scope/i.test(await page.locator('main, .admin-page').first().innerText()))
  await page.goto(`${BASE}/rates/plans/${ready.id}`); await page.waitForSelector('[data-testid=plan-status]', { timeout: 20000 })
  check('rate plan form shows status read-only (no status dropdown)', (await page.locator('select').evaluateAll((s) => s.filter((x) => [...x.options].some((o) => o.value === 'ACTIVE')).length)) === 0)

  // 9. keyboard, responsive, axe
  await open(); await page.keyboard.press('Tab')
  check('tab list is keyboard reachable', (await page.getByRole('tab', { name: 'Rate Plans', exact: true }).getAttribute('aria-selected')) === 'true')
  for (const [w, h] of [[1280, 800], [768, 900], [390, 800]]) {
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(300)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
    check(`no page-level horizontal overflow at ${w}px`, !overflow)
  }
  await page.setViewportSize({ width: 1280, height: 800 }); await page.screenshot({ path: `${SHOTS}/rate-plans-tab-after.png`, fullPage: true })
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  check('axe WCAG A/AA: no violations on the Rate Plans tab', axe.violations.length === 0, axe.violations.map((v) => `${v.id}(${v.nodes.length})`).join(','))

  // 10. a viewer without supply.rates.read has no tab; a plan from another tenant is invisible
  const viewer = await login(browser, seed.viewerEmail)
  await viewer.page.goto(`${BASE}/hotels/${hotelId}`); await viewer.page.waitForSelector('[data-testid=hotel-header], [data-state]', { timeout: 20000 })
  check('a viewer without supply.rates.read does not see the Rate Plans tab', (await viewer.page.getByRole('tab', { name: 'Rate Plans', exact: true }).count()) === 0)
  await viewer.ctx.close()
  const other = await login(browser, seed.bownerEmail)
  const cross = await other.page.request.get(`${BASE}/api/v1/supply/rate-plans/${ready.id}/readiness`)
  check('tenant B cannot read tenant A readiness (404)', cross.status() === 404)
  await other.ctx.close()
  check('no uncaught page errors', errors.length === 0, errors.join(' | '))

  await browser.close(); await prisma.$disconnect()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`); process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
