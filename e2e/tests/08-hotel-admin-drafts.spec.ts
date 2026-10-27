import { spawnSync } from 'node:child_process'
import { expect, test, type Dialog, type Page, type Route } from '@playwright/test'
import { DATABASE, ORIGINS, pgAdminUrl, urlFor } from '../support/config'
import { fixtures, signInAdmin } from '../support/helpers'

/**
 * Hotel admin drafts, in a real browser against the real API: independent drafts, edits during a slow save, failed saves, navigation protection and
 * the lifecycle control. Every test uses its own hotel, created through the UI, so nothing here depends on or disturbs the shared fixtures.
 */
const SETUP_PATCH = '**/api/v1/admin/hotels/*/setup'
const stamp = Date.now().toString(36)

/**
 * The preview admin is read-only by design. These tests edit hotels, so the disposable database's "Preview authorized admin" role is given the one
 * permission needed, as the database owner, before anyone signs in. It touches only the throwaway e2e database this suite itself creates.
 */
function grantHotelManage(): void {
  const admin = pgAdminUrl()
  const url = urlFor(admin, DATABASE, admin.username, decodeURIComponent(admin.password)).replace(/\?.*$/, '')
  const sql = `INSERT INTO "Permission"(id, key) VALUES ('e2e-hotels-manage', 'supply.hotels.manage') ON CONFLICT (key) DO NOTHING;
    INSERT INTO "RolePermission"(role_id, permission_id) SELECT r.id, p.id FROM "Role" r, "Permission" p WHERE r.name = 'Preview authorized admin' AND p.key = 'supply.hotels.manage' ON CONFLICT DO NOTHING;`
  const run = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`could not grant supply.hotels.manage to the preview admin role: ${run.stderr.slice(0, 300)}`)
}

async function createHotel(page: Page, label: string): Promise<string> {
  await page.goto(`${ORIGINS.admin}/hotels/new`)
  await page.getByLabel(/^NAME/).fill(`Draft Test ${label} ${stamp}`)
  await page.getByLabel('Country (ISO-2)').fill('AE')
  await page.getByLabel('City / destination').fill('Dubai')
  await page.getByLabel('IANA time zone').fill('Asia/Dubai')
  await page.getByRole('button', { name: 'Create hotel' }).click()
  await page.waitForURL(/\/hotels\/[^/?]+\?tab=setup/)
  return new URL(page.url()).pathname.split('/')[2]
}
/** A policy textarea. Its label wraps it, so its accessible name is the label plus the current text: match the start only. */
const policy = (page: Page, label: string) => page.getByRole('textbox', { name: new RegExp(`^${label}\\b`) })
const policiesUrl = (id: string) => `${ORIGINS.admin}/hotels/${id}?tab=policies`
const setupUrl = (id: string) => `${ORIGINS.admin}/hotels/${id}?tab=setup`

/** Records every dialog; answers each as told, in order, then dismisses any extra so a duplicate prompt is visible as a count. */
function dialogs(page: Page, answers: Array<'accept' | 'dismiss'>) {
  const seen: Array<{ type: string; message: string }> = []
  page.on('dialog', (d: Dialog) => { seen.push({ type: d.type(), message: d.message() }); void (answers[seen.length - 1] === 'accept' ? d.accept() : d.dismiss()) })
  return seen
}

/** Delays the PATCH of the setup endpoint, and records what each request carried. */
async function slowSetup(page: Page, ms: number) {
  const bodies: Array<Record<string, unknown>> = []
  await page.route(SETUP_PATCH, async (route: Route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    bodies.push(route.request().postDataJSON())
    await new Promise((r) => setTimeout(r, ms))
    await route.continue()
  })
  return bodies
}

test.describe.configure({ mode: 'serial' })

test.describe('Hotel admin drafts', () => {
  let hotel = ''
  test.beforeAll(async ({ browser }) => {
    grantHotelManage()
    const page = await browser.newPage()
    await signInAdmin(page)
    hotel = await createHotel(page, 'A')
    await page.close()
  })
  test.beforeEach(async ({ page }) => { await signInAdmin(page) })

  test('P1 saving local charges keeps the unsaved policy text, and policies then save without a stale-version error', async ({ page }) => {
    await page.goto(policiesUrl(hotel))
    const children = policy(page, 'Children')
    await children.fill('Children welcome under 12 (unsaved policy draft)')
    await page.getByRole('button', { name: 'Add charge' }).click()
    await page.getByLabel('Charge 1 amount').fill('20')
    await page.getByTestId('local-charges-save').click()
    await expect(page.getByTestId('policies-flash')).toContainText('Local charges saved')
    await expect(children).toHaveValue('Children welcome under 12 (unsaved policy draft)')
    await expect(page.getByTestId('policies-save')).toBeEnabled()
    await page.getByTestId('policies-save').click()
    await expect(page.getByTestId('policies-flash')).toContainText('Hotel policies saved')
    await expect(page.getByTestId('policies-error')).toHaveCount(0)
    await page.reload()
    await expect(policy(page, 'Children')).toHaveValue('Children welcome under 12 (unsaved policy draft)')
    await expect(page.getByLabel('Charge 1 amount')).toHaveValue('20.00')
  })

  test('P2 saving policies keeps an unsaved local-charge edit, and the reverse', async ({ page }) => {
    await page.goto(policiesUrl(hotel))
    await policy(page, 'Pets').fill('No pets (saved first)')
    await page.getByLabel('Charge 1 amount').fill('25')
    await page.getByTestId('policies-save').click()
    await expect(page.getByTestId('policies-flash')).toContainText('Hotel policies saved')
    await expect(page.getByLabel('Charge 1 amount')).toHaveValue('25')
    await expect(page.getByTestId('local-charges-save')).toBeEnabled()
    await page.getByTestId('local-charges-save').click()
    await expect(page.getByTestId('policies-flash')).toContainText('Local charges saved')
    await expect(page.getByTestId('local-charges-error')).toHaveCount(0)
  })

  test('P3 an edit typed while a save is in flight is kept, and only the submitted text was saved', async ({ page }) => {
    await page.goto(policiesUrl(hotel))
    const bodies = await slowSetup(page, 1500)
    const accessibility = policy(page, 'Accessibility')
    await accessibility.fill('Step-free entrance')
    await page.getByTestId('policies-save').click()
    await expect(page.getByRole('button', { name: 'Saving…' })).toBeVisible()
    await accessibility.fill('Step-free entrance and lift') // typed after submission
    await expect(page.getByTestId('policies-flash')).toContainText('Hotel policies saved', { timeout: 15_000 })
    await expect(accessibility).toHaveValue('Step-free entrance and lift')
    await expect(page.getByTestId('policies-save')).toBeEnabled() // still unsaved relative to the server
    expect((bodies[0].policies as Record<string, string>).accessibility).toBe('Step-free entrance')
    await page.unroute(SETUP_PATCH)
    await page.getByTestId('policies-save').click()
    await expect(page.getByTestId('policies-flash')).toContainText('Hotel policies saved')
    await page.reload()
    await expect(policy(page, 'Accessibility')).toHaveValue('Step-free entrance and lift')
  })

  test('P4 a failed save keeps the draft and the retry is a safe replay with the same idempotency key', async ({ page }) => {
    await page.goto(policiesUrl(hotel))
    const keys: string[] = []
    let calls = 0
    await page.route(SETUP_PATCH, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue()
      keys.push(route.request().postDataJSON().idempotencyKey)
      if (++calls === 1) return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'x-request-id': 'req-e2e-503' }, body: '{"success":false,"error":{"code":"UNAVAILABLE","message":"down"}}' })
      return route.continue()
    })
    const extra = policy(page, 'Extra beds')
    await extra.fill('Extra beds on request, AED 80')
    await page.getByTestId('policies-save').click()
    await expect(page.getByTestId('policies-error')).toContainText('Nothing was saved')
    await expect(page.getByTestId('policies-error')).toContainText('req-e2e-503')
    await expect(extra).toHaveValue('Extra beds on request, AED 80')
    await page.getByTestId('policies-save').click()
    await expect(page.getByTestId('policies-flash')).toContainText('Hotel policies saved')
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
  })

  test('P5 HTTP 200 with success:false, or with a malformed body, is shown as a failure, never as a save', async ({ page }) => {
    await page.goto(policiesUrl(hotel))
    const replies = [
      '{"success":false,"error":{"code":"HOTEL_POLICY_INVALID","message":"Policy text is not allowed.","details":["pets: too long"]}}',
      '<html>proxy error</html>',
      '{"saved":true}',
    ]
    await page.route(SETUP_PATCH, (route) => route.request().method() !== 'PATCH' ? route.continue() : route.fulfill({ status: 200, contentType: 'application/json', headers: { 'x-request-id': 'req-e2e-200' }, body: replies.shift()! }))
    const pets = policy(page, 'Pets')
    await pets.fill('Pets by arrangement')
    for (const expected of ['Policy text is not allowed.', 'unexpected response', 'unexpected response']) {
      await page.getByTestId('policies-save').click()
      await expect(page.getByTestId('policies-error')).toContainText(expected)
      await expect(page.getByTestId('policies-flash')).toHaveCount(0)
      await expect(pets).toHaveValue('Pets by arrangement')
    }
    await expect(page.getByTestId('policies-error')).toContainText('req-e2e-200')
  })

  test('P6 a stale version is explained; keeping my edits merges them onto the latest, discarding loads the latest', async ({ page, browser }) => {
    await page.goto(policiesUrl(hotel))
    const other = await browser.newPage(); await signInAdmin(other)
    await other.goto(policiesUrl(hotel))
    await policy(other, 'Children').fill('Changed elsewhere')
    await other.getByTestId('policies-save').click()
    await expect(other.getByTestId('policies-flash')).toContainText('Hotel policies saved')
    await other.close()

    await policy(page, 'Pets').fill('My pets edit')
    await page.getByTestId('policies-save').click()
    await expect(page.getByTestId('policies-error')).toContainText('changed after you loaded it')
    await expect(policy(page, 'Pets')).toHaveValue('My pets edit')
    await page.getByTestId('stale-keep').click()
    await expect(page.getByTestId('policies-error')).toHaveCount(0)
    await expect(policy(page, 'Pets')).toHaveValue('My pets edit')
    await expect(policy(page, 'Children')).toHaveValue('Changed elsewhere') // the newer value arrived
    await page.getByTestId('policies-save').click()
    await expect(page.getByTestId('policies-flash')).toContainText('Hotel policies saved')

    // Second round: this time discard.
    const again = await browser.newPage(); await signInAdmin(again)
    await again.goto(policiesUrl(hotel)); await policy(again, 'Pets').fill('Winner'); await again.getByTestId('policies-save').click()
    await expect(again.getByTestId('policies-flash')).toContainText('Hotel policies saved'); await again.close()
    await policy(page, 'Extra beds').fill('will be discarded')
    await page.getByTestId('policies-save').click()
    await page.getByTestId('stale-discard').click()
    await expect(policy(page, 'Extra beds')).not.toHaveValue('will be discarded')
    await expect(policy(page, 'Pets')).toHaveValue('Winner')
  })

  test('N1 one prompt for two dirty editors; declining stays, accepting leaves; the draft returns on coming back', async ({ page }) => {
    await page.goto(policiesUrl(hotel))
    await policy(page, 'Children').fill('Draft that must survive navigation')
    await page.getByLabel('Charge 1 amount').fill('31')
    const seen = dialogs(page, ['dismiss', 'accept'])
    await page.getByRole('link', { name: 'All hotels' }).click()
    await expect(page).toHaveURL(/tab=policies/)
    expect(seen).toHaveLength(1)
    await page.getByRole('link', { name: 'All hotels' }).click()
    await page.waitForURL(/\/hotels(\?|$)/)
    expect(seen).toHaveLength(2) // exactly one prompt per attempt, although two editors were dirty
    await page.goto(policiesUrl(hotel))
    await expect(page.getByTestId('draft-status').first()).toContainText('restored')
    await expect(policy(page, 'Children')).toHaveValue('Draft that must survive navigation')
    await expect(page.getByLabel('Charge 1 amount')).toHaveValue('31')
    await page.getByRole('button', { name: 'Discard edits' }).first().click()
    await page.getByRole('button', { name: 'Discard edits' }).first().click().catch(() => undefined)
  })

  test('N2 browser Back and Forward are guarded, with one prompt each, and the draft comes back after a confirmed leave', async ({ page }) => {
    // Same-document history only (client-side navigations): hotels -> hotel -> Hotel Profile -> Hotel Policies (a replace).
    await page.goto(`${ORIGINS.admin}/hotels`)
    await page.getByRole('main').getByRole('link', { name: new RegExp(`Draft Test A ${stamp}`) }).first().click()
    await page.getByRole('link', { name: 'Hotel Profile' }).first().click()
    await page.waitForURL(/tab=setup/)
    await page.locator('summary', { hasText: 'More hotel tools' }).click()
    await page.locator('#hotel-tab-policies').click()
    await page.waitForURL(/tab=policies/)
    await expect(page.getByTestId('policies-form')).toBeVisible()
    await policy(page, 'Children').fill('Typed before Back')
    await expect(page.getByRole('button', { name: 'Discard edits' }).first()).toBeVisible()

    const cdp = await page.context().newCDPSession(page)
    /** The browser's own Back/Forward button: a browser-initiated traversal (what a user's click or Alt+Left does). */
    const traverse = async (step: -1 | 1) => {
      const history = await cdp.send('Page.getNavigationHistory')
      await cdp.send('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex + step].id })
    }
    const seen = dialogs(page, ['dismiss', 'accept'])
    await traverse(-1)
    await expect.poll(() => seen.length).toBe(1)
    await expect(page).toHaveURL(/tab=policies/) // declined: still here
    await expect(policy(page, 'Children')).toHaveValue('Typed before Back') // and nothing was lost
    await traverse(-1)
    await expect.poll(() => seen.length).toBe(2)
    await expect(page).not.toHaveURL(/tab=/) // accepted: gone (the Policies tab replaced the Hotel Profile entry, so Back is the hotel's property page)
    expect(seen.every((d) => d.type === 'confirm')).toBe(true)

    await traverse(1) // Forward onto the editor again: nothing is dirty on the page just left, so no prompt
    await expect(page).toHaveURL(/tab=policies/)
    await expect(page.getByTestId('draft-status').first()).toContainText('restored')
    await expect(policy(page, 'Children')).toHaveValue('Typed before Back')
    expect(seen).toHaveLength(2)
    await page.getByRole('button', { name: 'Discard edits' }).first().click()
    await expect(policy(page, 'Children')).not.toHaveValue('Typed before Back')
  })

  test('N3 closing the tab with unsaved edits raises the browser prompt; a clean page does not', async ({ page }) => {
    await page.goto(policiesUrl(hotel))
    const seen: string[] = []
    page.on('dialog', (d) => { seen.push(d.type()); void d.dismiss() })
    await page.close({ runBeforeUnload: true })
    expect(seen).toEqual([]) // clean: closes silently
    const dirty = await page.context().newPage()
    await dirty.goto(policiesUrl(hotel))
    await policy(dirty, 'Children').click() // Chromium shows the beforeunload prompt only on a page the user has interacted with
    await policy(dirty, 'Children').fill('dirty')
    dirty.on('dialog', (d) => { seen.push(d.type()); void d.dismiss() })
    void dirty.close({ runBeforeUnload: true })
    await expect.poll(() => seen, { timeout: 8000 }).toEqual(['beforeunload'])
    expect(dirty.isClosed()).toBe(false) // dismissed: the page, and its draft, are still there
    await expect(policy(dirty, 'Children')).toHaveValue('dirty')
  })

  test('N4 a saved draft leaves nothing behind to restore', async ({ page }) => {
    await page.goto(policiesUrl(hotel))
    await policy(page, 'Children').fill('Saved then gone')
    await page.getByTestId('policies-save').click()
    await expect(page.getByTestId('policies-flash')).toContainText('Hotel policies saved')
    const seen = dialogs(page, [])
    await page.getByRole('link', { name: 'All hotels' }).click()
    await page.waitForURL(/\/hotels(\?|$)/)
    expect(seen).toHaveLength(0) // clean: no prompt
    await page.goto(policiesUrl(hotel))
    await expect(page.getByTestId('draft-status')).toHaveCount(0)
  })
})

test.describe('Hotel Setup form and shell navigation', () => {
  let hotel = ''
  test.beforeAll(async ({ browser }) => {
    grantHotelManage()
    const page = await browser.newPage()
    await signInAdmin(page)
    hotel = await createHotel(page, 'S')
    await page.close()
  })
  test.beforeEach(async ({ page }) => { await signInAdmin(page) })

  test('S1 setup: an edit typed during a slow save survives; private contacts never reach browser storage', async ({ page }) => {
    await page.goto(setupUrl(hotel))
    const name = page.getByRole('textbox', { name: /^Hotel name/ })
    const bodies = await slowSetup(page, 1500)
    const first = `Renamed ${stamp}`
    await name.fill(first)
    await page.getByTestId('setup-save').click()
    await expect(page.getByRole('button', { name: 'Saving…' })).toBeVisible()
    await name.fill(`${first} and more`)
    await expect(page.getByTestId('setup-notice')).toContainText('Saved', { timeout: 15_000 })
    await expect(name).toHaveValue(`${first} and more`)
    await expect(page.getByTestId('setup-save')).toBeEnabled() // the later edit is still unsaved
    expect(bodies[0].name).toBe(first)
    await page.unroute(SETUP_PATCH)

    // A contact email is typed with the name edit. Both are unsaved; the guard keeps the draft on a confirmed leave, but not the contact.
    await page.getByRole('textbox', { name: /^reservations email/i }).fill('secret.contact@example.test')
    const seen = dialogs(page, ['accept'])
    await page.getByRole('link', { name: 'All hotels' }).click()
    await page.waitForURL(/\/hotels(\?|$)/)
    expect(seen).toHaveLength(1)
    const stored = await page.evaluate(() => Object.entries(sessionStorage).map(([k, v]) => `${k}=${v}`).join('\n'))
    expect(stored).toContain(`${first} and more`)
    expect(stored).not.toContain('secret.contact@example.test')
    await page.goto(setupUrl(hotel))
    await expect(page.getByTestId('draft-status').first()).toContainText('restored')
    await expect(page.getByRole('textbox', { name: /^Hotel name/ })).toHaveValue(`${first} and more`)
    await expect(page.getByRole('textbox', { name: /^reservations email/i })).toHaveValue('')
    await page.getByRole('button', { name: 'Discard edits' }).first().click()
  })

  test('N5 a tab change and a hotel switch from the header each raise exactly one prompt while a draft is unsaved', async ({ page }) => {
    await page.goto(policiesUrl(hotel))
    await policy(page, 'Pets').fill('unsaved pets text')
    const seen = dialogs(page, ['dismiss', 'dismiss', 'accept'])
    await page.locator('#hotel-tab-rooms').click() // a management tab (a Link with replace)
    await expect.poll(() => seen.length).toBe(1)
    await expect(page).toHaveURL(/tab=policies/)
    await page.locator('.hotel-property-picker summary').click()
    const other = page.locator('.hotel-property-results a:not([aria-current="page"])').first()
    await other.click()
    await expect.poll(() => seen.length).toBe(2)
    await expect(page).toHaveURL(/tab=policies/)
    await page.locator('#hotel-tab-rooms').click()
    await page.waitForURL(/tab=rooms/)
    expect(seen).toHaveLength(3) // accepted: left; one prompt per attempt
  })

  test('N6 signing out with an unsaved draft asks first, and sign-out leaves no draft in the tab', async ({ page }) => {
    await page.goto(policiesUrl(hotel))
    await policy(page, 'Pets').fill('must not outlive the session')
    const seen = dialogs(page, ['dismiss', 'accept'])
    const signOut = async () => { await page.locator('summary[aria-label="User account"]').click(); await page.getByRole('button', { name: 'Sign out' }).click() }
    await signOut()
    await expect.poll(() => seen.length).toBe(1)
    await expect(page).toHaveURL(/tab=policies/)
    await page.getByRole('button', { name: 'Sign out' }).click() // the account menu is still open after declining
    await expect.poll(() => seen.length).toBe(2)
    await page.waitForURL(/\/login/)
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('fbeds:draft:')))).toEqual([])
  })
})

test.describe('Lifecycle control', () => {
  test('L1 a DRAFT hotel has no preselected target, offers only allowed transitions, and submits exactly the visible choice', async ({ page }) => {
    grantHotelManage()
    await signInAdmin(page)
    const id = await createHotel(page, 'L')
    await page.goto(setupUrl(id))
    const select = page.getByTestId('status-target')
    await expect(page.getByTestId('profile-status')).toHaveText('DRAFT')
    await expect(select).toHaveValue('')
    const options = await select.locator('option').allTextContents()
    expect(options).toEqual(['Select a status…', 'INCOMPLETE', 'SUSPENDED', 'ARCHIVED'])
    await page.getByLabel(/Reason \(required\)/).last().fill('Planned review')
    await expect(page.getByTestId('status-apply')).toBeDisabled() // nothing chosen yet
    await select.selectOption('SUSPENDED')
    await expect(select).toHaveValue('SUSPENDED')
    const sent: Array<Record<string, unknown>> = []
    await page.route('**/api/v1/admin/hotels/*/setup/status', (route) => { sent.push(route.request().postDataJSON()); return route.continue() })
    await page.getByTestId('status-apply').click()
    await expect(page.getByTestId('status-notice')).toContainText('Status is now SUSPENDED')
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('SUSPENDED')
    // From SUSPENDED the list is derived afresh (DRAFT is now a legal target, SUSPENDED is not) and nothing is preselected.
    await expect(select).toHaveValue('')
    expect(await select.locator('option').allTextContents()).toEqual(['Select a status…', 'DRAFT', 'INCOMPLETE', 'ARCHIVED'])
  })
})

void fixtures
