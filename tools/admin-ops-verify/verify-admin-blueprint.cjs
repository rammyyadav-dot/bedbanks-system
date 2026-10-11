// Browser check of the Admin blueprint changes (ADR 0051, 0053, 0054 slice 1): Business nav, Hotels saved views, bulk owner, export, Search Monitor, Payables.
// Run after seed-hotels.ts and after granting the seeded owner role supply.hotels.export, audit.read and finance.read (see README). Not run in CI.
const path = require('path')
const { createRequire } = require('module')
const req = createRequire(path.join(__dirname, '../../apps/website/package.json'))
const { chromium } = req('@playwright/test')
const AxeBuilder = req('@axe-core/playwright').default || req('@axe-core/playwright')
const seed = require(process.env.SEED_JSON ?? path.join(__dirname, '.seed-hotels.json'))
const BASE = process.env.ADMIN_URL ?? 'http://localhost:3000'
const SHOTS = process.env.SHOT_DIR ?? require('os').tmpdir()
const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 160) : ''}`) }

async function login(browser, email) {
  const ctx = await browser.newContext({ acceptDownloads: true }); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}

;(async () => {
  const browser = await chromium.launch()
  const { ctx, page } = await login(browser, seed.ownerEmail)
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(`${BASE}/hotels`); await page.waitForSelector('[data-testid=hotels-table]', { timeout: 20000 })
  const nav = (await page.locator('nav, aside').first().innerText()).replace(/\s+/g, ' ')
  check('sidebar has a Business group with Tenants, from the catalogue', /business/i.test(nav) && /Tenants/.test(nav), nav.slice(0, 120))
  check('sidebar shows Search monitor and Payables only as real links', /Search monitor/.test(nav) && /Payables/.test(nav))

  // saved views
  await page.goto(`${BASE}/hotels?readiness=BLOCKED`); await page.waitForSelector('[data-testid=hotels-table], [data-state]')
  await page.getByPlaceholder('View name').fill('Blocked now'); await page.getByRole('button', { name: 'Save view' }).click()
  check('saving a view confirms it', /View saved/.test(await page.locator('[data-testid=hotel-saved-views]').innerText()))
  await page.goto(`${BASE}/hotels`); await page.waitForSelector('[data-testid=hotels-table]')
  await page.getByLabel('Saved views (this browser)').selectOption('Blocked now')
  await page.waitForFunction(() => location.search.includes('readiness=BLOCKED'))
  check('choosing a saved view rewrites the URL filters', page.url().includes('readiness=BLOCKED'))
  await page.getByPlaceholder('View name').fill('x'); await page.goto(`${BASE}/hotels`); await page.waitForSelector('[data-testid=hotels-table]')
  await page.getByLabel('Saved views (this browser)').selectOption('Blocked now'); await page.getByRole('button', { name: 'Delete view' }).click()
  check('a view can be deleted', /No saved views/.test(await page.locator('[data-testid=hotel-saved-views]').innerText()))

  // summary tiles
  check('summary shows profile-status tiles', /Draft profiles/.test(await page.locator('[data-testid=hotels-summary]').innerText()))

  // export (honours the filters on screen, so start from the unfiltered list)
  await page.goto(`${BASE}/hotels`); await page.waitForSelector('[data-testid=hotels-table]')
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.getByRole('button', { name: 'Export CSV' }).click()])
  const file = await download.path(); const csv = require('fs').readFileSync(file, 'utf8')
  check('export downloads a CSV with the directory header and tenant hotels only', csv.startsWith('canonical_id,name,') && csv.includes('Atlantis Palm Resort') && !csv.includes('Other Tenant Hotel'), `${csv.split('\r\n').length - 2} rows; atlantis=${csv.includes('Atlantis Palm Resort')} other=${csv.includes('Other Tenant Hotel')}`)
  check('export reports the row count', /Exported \d+ hotels/.test(await page.locator('main, .admin-page').first().innerText()))

  // bulk owner
  await page.goto(`${BASE}/hotels`); await page.waitForSelector('[data-testid=hotels-table]')
  await page.getByLabel('Select Atlantis Palm Resort').check(); await page.getByLabel('Select Burj View Hotel').check()
  await page.waitForSelector('[data-testid=bulk-owner]')
  await page.getByLabel('Search members').fill('checker'); await page.getByRole('button', { name: 'Find' }).click()
  await page.getByLabel('Choose owner').selectOption({ index: 1 })
  const apply = page.getByRole('button', { name: 'Apply to selected' })
  check('apply is disabled until a reason is given', await apply.isDisabled())
  await page.locator('[data-testid=bulk-owner] label:has-text("Reason") input').fill('Handover to checker'); await apply.click()
  await page.waitForSelector('[data-testid=bulk-owner-results]')
  check('bulk owner assigns both hotels', /2 assigned/.test(await page.locator('[data-testid=bulk-owner-results]').innerText()), await page.locator('[data-testid=bulk-owner-results]').innerText())
  await apply.click().catch(() => undefined); await page.waitForTimeout(800)
  check('repeating the same assignment skips hotels already set', /2 already set/.test(await page.locator('[data-testid=bulk-owner-results]').innerText()))
  await page.screenshot({ path: `${SHOTS}/hotels-bulk-owner.png`, fullPage: true })

  // search monitor and payables
  await page.goto(`${BASE}/distribution/search-monitor`); await page.waitForSelector('[data-testid=search-monitor], [data-state]', { timeout: 20000 })
  const mon = (await page.locator('main, .admin-page').first().innerText()).replace(/\s+/g, ' ')
  check('search monitor shows outcomes and counts the source failure as unavailable, not empty', /Source unavailable/.test(mon) && /No availability/.test(mon), mon.slice(0, 200))
  check('breadcrumb has no duplicated trailing segment', (await page.locator('.breadcrumb strong').allInnerTexts()).join('|') === 'Search monitor')
  await page.screenshot({ path: `${SHOTS}/search-monitor.png`, fullPage: true })
  await page.goto(`${BASE}/finance/payables`); await page.waitForSelector('[data-testid=supplier-payables], [data-state]', { timeout: 20000 })
  const pay = (await page.locator('main, .admin-page').first().innerText()).replace(/\s+/g, ' ')
  check('payables shows the accrual and its not-an-amount-owed definition', /Supplier payables/.test(pay) && /accrual/i.test(pay), pay.slice(0, 200))
  await page.screenshot({ path: `${SHOTS}/payables.png`, fullPage: true })


  // accessibility (WCAG A/AA) and horizontal overflow on the new pages and the Hotels list with its new controls
  for (const [label, url, ready] of [['hotels list', '/hotels', '[data-testid=hotels-table]'], ['search monitor', '/distribution/search-monitor', '[data-testid=search-monitor]'], ['payables', '/finance/payables', '[data-testid=supplier-payables]']]) {
    await page.goto(`${BASE}${url}`); await page.waitForSelector(ready, { timeout: 20000 })
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    check(`axe WCAG A/AA: ${label}`, axe.violations.length === 0, axe.violations.map((x) => `${x.id}(${x.nodes.length})`).join(','))
    for (const w of [1280, 768, 390]) {
      await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(200)
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      check(`no horizontal page overflow at ${w}px: ${label}`, over <= 1, `${over}px`)
    }
    await page.setViewportSize({ width: 1280, height: 900 })
  }

  // a viewer holds none of the new permissions
  const v = await login(browser, seed.viewerEmail)
  await v.page.goto(`${BASE}/hotels`); await v.page.waitForSelector('[data-testid=hotels-table]', { timeout: 20000 })
  check('a read-only viewer sees no export button and no selection boxes', (await v.page.getByRole('button', { name: 'Export CSV' }).count()) === 0 && (await v.page.getByLabel(/^Select /).count()) === 0)
  await v.ctx.close()

  check('no uncaught page errors', errors.length === 0, errors.join(' | '))
  await browser.close()
  const failed = results.filter((r) => !r).length
  console.log(`${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
