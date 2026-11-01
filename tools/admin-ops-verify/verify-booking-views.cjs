// Real-stack browser verification of saved booking views and the canonical query filters (ADR 0039, Phase 6A/6B): production Admin build, API on the STRICT runtime
// role, booking module on its own role. Needs OWNER_DATABASE_URL for evidence reads and fixtures. Run seed-bookings.ts first. Not run in CI.
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
const RUN = Date.now().toString(36)
const STALE = `stale-${RUN}`; const RESTRICTED = `restricted-${RUN}`
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 200) : ''}`) }
const sql = (q) => execFileSync('psql', [OWNER, '-Atqc', q]).toString().trim()
const userId = (email) => sql(`SELECT id FROM users WHERE email='${email}'`)
const views = (email) => sql(`SELECT coalesce(string_agg(name || '|' || version || '|' || coalesce(default_slot::text,'-'), ';' ORDER BY name_key), '') FROM "BookingSavedView" WHERE owner_user_id='${userId(email)}' AND tenant_id='${seed.tenant}'`)
async function login(browser, email) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${BASE}/login`); await page.fill('#email', email); await page.fill('#password', seed.password)
  await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 })
  return { ctx, page }
}
// The count of a settled list: the same non-loading number twice, 400 ms apart (a count read mid-reload would be the previous list's).
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
const viewInUrl = (page, id) => page.waitForFunction((v) => new URL(location.href).searchParams.get('view') === v, id, { timeout: 15000 }).then(() => true, () => false)
const note = async (page, re) => { await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-testid=view-note]')?.textContent ?? ''), re.source, { timeout: 15000 }) }
const apply = async (page) => { await page.getByRole('form', { name: 'Booking filters' }).getByRole('button', { name: 'Apply' }).click(); await page.waitForTimeout(400) }
const search = (page) => new URL(page.url()).searchParams

;(async () => {
  const browser = await chromium.launch()
  let { page, ctx } = await login(browser, seed.leadEmail)
  const writes = []; page.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method()) && !r.url().includes('/auth/')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`) })
  await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-testid=saved-views]', { timeout: 20000 })
  check('the saved-views toolbar is shown to a person who holds the saved-view permission', await page.getByTestId('saved-views').isVisible())

  // ---- 6B: save, open, modify, update, rename, save as new ----
  await page.getByRole('form', { name: 'Booking filters' }).getByLabel('Supplier', { exact: true }).fill('Global Hotel Supply'); await apply(page)
  const total = await count(page)
  await page.getByRole('button', { name: 'Save current view…' }).click(); await page.waitForSelector('[role=dialog]')
  const ax = await new AxeBuilder({ page }).include('[role=dialog]').withTags(['wcag2a', 'wcag2aa']).analyze(); const bad = ax.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
  check('axe WCAG A/AA clean in the save dialog', bad.length === 0, bad.map((v) => v.id).join(','))
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
  check('a name is required (nothing is sent without one)', await page.getByRole('alert').filter({ hasText: 'A name is required' }).isVisible() && writes.length === 0)
  await page.getByRole('dialog').getByLabel(/Name/).fill('Global supplier bookings'); await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
  await note(page, /saved/)
  check('the view is saved for this person with canonical filters, no tenant and no paging', views(seed.leadEmail).startsWith('Global supplier bookings|1|-') && !/tenant|page/i.test(sql(`SELECT filters_json::text FROM "BookingSavedView" WHERE name='Global supplier bookings' AND tenant_id='${seed.tenant}'`)))
  const viewId = sql(`SELECT id FROM "BookingSavedView" WHERE name='Global supplier bookings' AND tenant_id='${seed.tenant}'`)
  check('the new view becomes the active one and is named in the URL (UI-only marker)', await viewInUrl(page, viewId))
  await page.goto(`${BASE}/bookings?chip=latest`); await page.waitForSelector('[data-testid=view-select]')
  await page.getByTestId('view-select').selectOption(viewId); await page.waitForTimeout(500)
  const p = search(page)
  check('opening a view resolves into the normal booking-query URL, and the list shows the same count', p.get('supplier') === 'Global Hotel Supply' && p.get('view') === viewId && (await count(page)) === total, `${total} vs ${await page.getByTestId('result-count').innerText()}`)
  check('an unmodified view shows no "changed" marker', (await page.getByTestId('view-modified').count()) === 0)
  await page.getByRole('form', { name: 'Booking filters' }).getByLabel('Supplier', { exact: true }).fill('Supplier One'); await apply(page)
  check('changing a filter marks the view as changed', await page.getByTestId('view-modified').isVisible())
  await page.getByRole('button', { name: 'Update view' }).click(); await note(page, /updated/)
  check('"Update view" saves the new filters under the same view (version 2) and clears the marker', views(seed.leadEmail).startsWith('Global supplier bookings|2|-') && /Supplier One/.test(sql(`SELECT filters_json::text FROM "BookingSavedView" WHERE id='${viewId}'`)))
  await page.getByRole('button', { name: 'Rename…' }).click(); await page.getByRole('dialog').getByLabel(/Name/).fill('Supplier One bookings'); await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click(); await note(page, /renamed/)
  check('rename changes only the name', views(seed.leadEmail).startsWith('Supplier One bookings|3|-'))
  await page.getByRole('button', { name: 'Save as new view…' }).click(); await page.getByRole('dialog').getByLabel(/Name/).fill('SUPPLIER ONE BOOKINGS'); await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'already have a view with that name' }).waitFor({ timeout: 10000 }).catch(() => undefined)
  check('names are unique per person ignoring case: a duplicate is refused in plain words', await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'already have a view with that name' }).isVisible())
  await page.getByRole('dialog').getByLabel(/Name/).fill('Copy of supplier one'); await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click(); await note(page, /saved/)
  check('save as new creates a second, independent view', (views(seed.leadEmail).match(/;/g) ?? []).length === 1)

  // ---- default view and reset ----
  const copyId = sql(`SELECT id FROM "BookingSavedView" WHERE name='Copy of supplier one' AND tenant_id='${seed.tenant}'`)
  await page.getByRole('button', { name: 'Set as default' }).click(); await note(page, /Default view set/)
  check('exactly one default exists for the person', sql(`SELECT count(*) FROM "BookingSavedView" WHERE owner_user_id='${userId(seed.leadEmail)}' AND default_slot=1`) === '1')
  await page.goto(`${BASE}/bookings`); await page.waitForFunction(() => new URL(location.href).searchParams.has('view'), null, { timeout: 15000 })
  check('a blank visit opens the default view', search(page).get('view') === copyId && search(page).get('supplier') === 'Supplier One')
  await page.goto(`${BASE}/bookings?chip=failed`); await page.waitForSelector('[data-testid=view-select]'); await page.waitForTimeout(800)
  check('a visit that already has filters is left alone (the default is not forced on top)', search(page).get('chip') === 'failed' && !search(page).has('view'))
  await page.getByRole('button', { name: 'Reset to system default' }).click(); await note(page, /Reset/)
  check('"Reset to system default" removes the default and returns to Needs action', sql(`SELECT count(*) FROM "BookingSavedView" WHERE owner_user_id='${userId(seed.leadEmail)}' AND default_slot=1`) === '0' && !search(page).has('view'))
  await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-testid=view-select]'); await page.waitForTimeout(800)
  check('after the reset a blank visit stays on the system default', !search(page).has('view'))

  // ---- delete ----
  await page.getByTestId('view-select').selectOption(copyId); await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Delete…' }).click(); await page.waitForSelector('[data-testid=view-delete]')
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click(); await note(page, /deleted/)
  check('delete removes the view, only', !/Copy of supplier one/.test(views(seed.leadEmail)) && /Supplier One bookings/.test(views(seed.leadEmail)))
  const audit = sql(`SELECT string_agg(action, ',' ORDER BY created_at) FROM "AuditEvent" WHERE tenant_id='${seed.tenant}' AND action LIKE 'booking.savedview.%' AND user_id='${userId(seed.leadEmail)}'`)
  check('every change was audited, and no audit payload carries filters or names', /created/.test(audit) && /updated/.test(audit) && /default_set/.test(audit) && /default_cleared/.test(audit) && /deleted/.test(audit) && !/Supplier One|Global Hotel/.test(sql(`SELECT string_agg(payload::text, ' ') FROM "AuditEvent" WHERE action LIKE 'booking.savedview.%' AND tenant_id='${seed.tenant}'`)), audit)

  // ---- stale and restricted views are never applied ----
  sql(`INSERT INTO "BookingSavedView" (id, tenant_id, owner_user_id, name, name_key, filters_json, sort_json, updated_at) VALUES ('${STALE}', '${seed.tenant}', '${userId(seed.leadEmail)}', 'Old grammar', 'old grammar', '{"status":"NO_LONGER_A_STATUS"}', '{"sort":"created","dir":"desc"}', now())`)
  await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-testid=view-select]')
  const staleOpt = page.locator('[data-testid=view-select] option', { hasText: 'Old grammar' })
  check('a view the grammar no longer accepts is listed as "cannot be applied" and cannot be selected', (await staleOpt.getAttribute('disabled')) !== null && /cannot be applied/.test(await staleOpt.innerText()))
  await page.goto(`${BASE}/bookings?view=${STALE}`); await page.waitForSelector('[data-testid=view-problem]')
  check('opening it by link explains why and applies nothing', /no longer understands/.test(await page.getByTestId('view-problem').innerText()) && (await page.getByRole('button', { name: 'Update view' }).isDisabled()))
  await ctx.close()

  // ---- privacy between people ----
  ;({ page, ctx } = await login(browser, seed.views2Email))
  await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-testid=saved-views]')
  const opts = await page.locator('[data-testid=view-select] option').allInnerTexts()
  check('another person sees none of the first person\'s views', opts.length === 1 && !opts.some((o) => /Supplier One|Old grammar/.test(o)), opts.join(' | '))
  check('and their link to a view that is not theirs opens nothing', await (async () => { await page.goto(`${BASE}/bookings?view=${viewId}`); await page.waitForSelector('[data-testid=saved-views]'); return (await page.getByTestId('view-problem').count()) === 0 && (await page.getByTestId('view-select').inputValue()) === '' })())
  const direct = await page.request.get(`${BASE}/api/v1/admin/operations/booking-views/${viewId}`); check('the API answers 404 (not 403) for someone else\'s view', direct.status() === 404)
  const patch = await page.request.patch(`${BASE}/api/v1/admin/operations/booking-views/${viewId}`, { data: { expectedVersion: 3, name: 'hijacked' }, headers: { Origin: BASE } }); check('and refuses to change it', patch.status() === 404 && /Supplier One bookings/.test(views(seed.leadEmail)))
  sql(`INSERT INTO "BookingSavedView" (id, tenant_id, owner_user_id, name, name_key, filters_json, sort_json, updated_at) VALUES ('${RESTRICTED}', '${seed.tenant}', '${userId(seed.views2Email)}', 'Guest search', 'guest search', '{"guest":"Haddad"}', '{"sort":"created","dir":"desc"}', now())`)
  await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-testid=view-select]')
  const restricted = page.locator('[data-testid=view-select] option', { hasText: 'Guest search' })
  check('a view that uses a filter this person may not use (guest names) is not applied', (await restricted.getAttribute('disabled')) !== null)
  await page.goto(`${BASE}/bookings?view=${RESTRICTED}`); await page.waitForSelector('[data-testid=view-problem]'); check('and says so', /no longer have access/.test(await page.getByTestId('view-problem').innerText()))
  const refused = await page.request.get(`${BASE}/api/v1/admin/operations/bookings?guest=Haddad`); check('the list itself refuses that filter for them (403), saved or not', refused.status() === 403)
  await ctx.close()

  // ---- someone without the saved-view permission ----
  ;({ page, ctx } = await login(browser, seed.opsEmail)); await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-testid=bookings-table], [data-testid=booking-empty]')
  check('a person without the saved-view permission sees no toolbar', (await page.getByTestId('saved-views').count()) === 0)
  check('and the API refuses them the views', (await page.request.get(`${BASE}/api/v1/admin/operations/booking-views`)).status() === 403)
  await ctx.close()

  // ---- 6A: the canonical filters in the UI ----
  ;({ page, ctx } = await login(browser, seed.leadEmail)); await page.goto(`${BASE}/bookings?chip=latest`); await page.waitForSelector('[data-testid=bookings-table]')
  const form = page.getByRole('form', { name: 'Booking filters' })
  await form.getByLabel('Destination (city / country)').fill('dubai'); await form.getByLabel('Source').selectOption('MANUAL'); await apply(page)
  const manualDubai = sql(`SELECT count(*) FROM "Booking" b JOIN "Hotel" h ON h.id=b.hotel_id WHERE b.tenant_id='${seed.tenant}' AND b.channel='MANUAL' AND (h.city ILIKE '%dubai%' OR h.country_code ILIKE 'dubai')`)
  check('destination and source filter the list; the count matches the database', (await count(page)) === Number(manualDubai), `${manualDubai}`)
  await form.getByLabel('Destination (city / country)').fill(''); await form.getByLabel('Source').selectOption(''); await form.getByLabel('Currency').fill('AED'); await form.getByLabel('Amount from').fill('1000.00'); await form.getByLabel('Amount to').fill('2000.00'); await apply(page)
  const aed = sql(`SELECT count(*) FROM "Booking" WHERE tenant_id='${seed.tenant}' AND currency='AED' AND total_minor BETWEEN 100000 AND 200000`)
  check('a currency with an amount range filters in integer minor units (AED 1,000.00 to 2,000.00)', search(page).get('amountMin') === '100000' && search(page).get('amountMax') === '200000' && (await count(page)) === Number(aed), `${aed}`)
  await form.getByLabel('Currency').fill(''); await page.waitForTimeout(100)
  check('amount fields are disabled without a currency', await form.getByLabel('Amount from').isDisabled())
  const badField = await page.request.get(`${BASE}/api/v1/admin/operations/bookings?tenantId=${seed.tenant}`); check('the API rejects an unsupported field such as tenantId (400)', badField.status() === 400)
  const bad2 = await page.request.get(`${BASE}/api/v1/admin/operations/bookings?amountMin=100`); check('and an amount range without a currency (400)', bad2.status() === 400)
  const ax2 = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze(); const bad3 = ax2.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
  check('axe WCAG A/AA clean on the list with the toolbar and the new filters', bad3.length === 0, bad3.map((v) => v.id + ':' + v.nodes.length).join(','))
  await page.setViewportSize({ width: 390, height: 800 }); await page.goto(`${BASE}/bookings`); await page.waitForSelector('[data-testid=saved-views]')
  check('no horizontal page scroll at 390px with the toolbar', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))

  check('every write was a saved-view route (no tenant or owner in any body)', writes.length > 0 && writes.every((w) => /\/api\/v1\/admin\/operations\/booking-views/.test(w)), writes.join(' | '))
  await ctx.close(); await browser.close()
  const failed = results.filter((r) => !r.ok); console.log(`\n${results.length - failed.length}/${results.length} passed`); process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
