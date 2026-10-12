// Real-stack check of duplicate-aware supplier mapping (ADR 0059). Run after seed-hotels.ts, against an owner-connected API on a disposable database.
const path = require('path')
const { createRequire } = require('module')
const { chromium } = createRequire(path.join(__dirname, '../../apps/website/package.json'))('@playwright/test')
const { PrismaClient } = createRequire(path.join(__dirname, '../../apps/api/package.json'))('@prisma/client')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-hotels.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const prisma = new PrismaClient()
let failed = 0
const check = (name, ok, extra = '') => { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 160) : ''}`) }

;(async () => {
  // Arrange: a second canonical entry for the same property (similar name, same position) whose supplier mapping is still PENDING.
  // (External identifiers are unique per tenant, so a shared identifier cannot occur inside one tenant.)
  const alpha = await prisma.hotel.findUniqueOrThrow({ where: { id: seed.hotels.alpha } })
  const mapped = await prisma.supplierHotelMapping.findFirstOrThrow({ where: { hotelId: alpha.id, status: 'MAPPED' } })
  await prisma.hotel.update({ where: { id: alpha.id }, data: { latitude: '25.200000', longitude: '55.270000' } })
  const dupe = await prisma.hotel.create({ data: { tenantId: alpha.tenantId, name: `${alpha.name} Old`, propertyType: 'HOTEL', city: alpha.city, countryCode: alpha.countryCode, latitude: '25.200100', longitude: '55.270000', contentStatus: 'DRAFT' } })
  const pending = await prisma.supplierHotelMapping.create({ data: { tenantId: alpha.tenantId, supplierId: mapped.supplierId, hotelId: dupe.id, supplierHotelId: `DUP-SUP-${Date.now()}` } })

  const browser = await chromium.launch()
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', seed.ownerEmail); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })

  await page.goto(`${BASE}/hotels/${dupe.id}?tab=mappings`); await page.waitForSelector('[data-testid=hotel-mappings]', { timeout: 20000 })
  const row = page.locator(`tr[data-mapping-id="${pending.id}"]`)
  await row.getByRole('button', { name: /approve/i }).click()
  await row.getByLabel(/Reason for approving/).fill('Checked against the supplier extranet')
  await row.getByRole('button', { name: /Confirm approve/i }).click()
  await page.waitForSelector('[data-testid=mapping-duplicate-conflict]', { timeout: 15000 })
  const panel = await page.getByTestId('mapping-duplicate-conflict').innerText()
  check('a refused approval names the already-verified duplicate hotel and its supplier id', panel.includes(alpha.name) && panel.includes(mapped.supplierHotelId) && /similar name within 150 m/.test(panel), panel)
  check('the mapping is still pending after the refusal', (await prisma.supplierHotelMapping.findUniqueOrThrow({ where: { id: pending.id } })).status === 'PENDING')
  check('"Verify anyway" is disabled until the operator confirms', await page.getByTestId('mapping-duplicate-approve').isDisabled())
  await page.getByTestId('mapping-duplicate-confirm').check()
  await page.getByTestId('mapping-duplicate-approve').click()
  await page.waitForSelector('[data-testid=mapping-flash]:has-text("duplicate acknowledged")', { timeout: 15000 })
  check('after confirming, the mapping is verified', (await prisma.supplierHotelMapping.findUniqueOrThrow({ where: { id: pending.id } })).status === 'MAPPED')
  const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: pending.id, action: 'supply.hotel_mapping.approved' } })
  check('the acknowledgement and reason are in the audit event', JSON.stringify(audit.payload).includes(alpha.id) && /supplier extranet/.test(JSON.stringify(audit.payload)))

  await browser.close(); await prisma.$disconnect()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed'); process.exit(failed ? 1 : 0)
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
