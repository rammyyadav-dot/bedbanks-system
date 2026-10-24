import { spawnSync } from 'node:child_process'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { DATABASE, ORIGINS, pgAdminUrl, urlFor } from '../support/config'
import { ACCOUNTS, fixtures, passwordFor, type AccountKey } from '../support/helpers'
import { SELLABLE_STAY, call, login, offerSearchBody } from '../support/api'

/**
 * Hotel deals and promotions (ADR 0089) through the real Admin portal, the real API on the strict runtime role and the real database. One person drafts, a different
 * person approves and activates, and the Agent search then prices the deal. The owner connection is used only to arrange two Admin users and to observe.
 */
const MAKER = 'preview-deal-maker@example.test'
const CHECKER = 'preview-deal-checker@example.test'
const KEYS = ['dashboard.read', 'supply.hotels.read', 'supply.rooms.read', 'supply.rates.read', 'supply.rates.manage', 'supply.contracts.read', 'supply.mappings.read', 'supply.availability.read', 'supply.suppliers.read']
const code = `UI${Date.now().toString(36).toUpperCase()}`
const NAME = `UI summer special ${code}`

function owner(statement: string): string {
  const admin = pgAdminUrl()
  const url = urlFor(admin, DATABASE, admin.username, decodeURIComponent(admin.password)).replace(/\?.*$/, '')
  const r = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || '').split('\n').slice(-3).join(' ').replace(/postgres(ql)?:\/\/[^\s'"]+/g, '<redacted>')}`)
  return r.stdout.trim()
}

async function signIn(page: Page, email: string, passwordOf: AccountKey = 'admin'): Promise<void> {
  await page.goto(`${ORIGINS.admin}/login`)
  await page.getByLabel('Work email').fill(email)
  await page.getByLabel('Password').fill(passwordFor(passwordOf))
  await page.getByRole('button', { name: /sign in securely/i }).click()
  await page.waitForURL(/\/dashboard/)
}
async function as(browser: Browser, email: string, passwordOf: AccountKey = 'admin'): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page, email, passwordOf)
  return page
}

/** The Agent search price of the first plan of the preview hotel, read through the real API as the preview agent. */
async function agentPrice(): Promise<{ total: number; promotion?: { name: string } } | undefined> {
  const { cookie } = await login('agent')
  const stay = SELLABLE_STAY()
  const reply = await call('/agent/search', { cookie, origin: ORIGINS.agent, json: offerSearchBody(stay.checkIn, stay.checkOut) })
  expect(reply.status).toBe(201)
  const hotel = (reply.body.data.hotels as Array<{ hotelId: string; rooms: Array<{ rates: Array<{ sellAmountMinor: number; promotion?: { name: string } }> }> }>).find((h) => h.hotelId === fixtures().hotelAlpha)
  const rate = hotel?.rooms.flatMap((room) => room.rates)[0]
  return rate ? { total: rate.sellAmountMinor, promotion: rate.promotion } : undefined
}

test.describe.configure({ mode: 'serial' })
test.describe('Hotel deals and promotions: draft, approve, activate, price, stop', () => {
  let dealUrl = ''
  let page: Page; let checker: Page

  test.beforeAll(async ({ browser }) => {
    const tenant = fixtures().tenantA
    const hash = owner(`SELECT password_hash FROM users WHERE email = '${ACCOUNTS.admin}'`)
    owner(`INSERT INTO "Role" (id, name, tenant_id) VALUES ('deal-role-${code}', 'Preview deal managers ${code}', '${tenant}') ON CONFLICT DO NOTHING`)
    for (const key of KEYS) owner(`INSERT INTO "Permission" (id, key, description) VALUES ('perm-${key}-${code}', '${key}', '${key}') ON CONFLICT (key) DO NOTHING`)
    owner(`INSERT INTO "RolePermission" (role_id, permission_id) SELECT 'deal-role-${code}', id FROM "Permission" WHERE key IN (${KEYS.map((k) => `'${k}'`).join(', ')}) ON CONFLICT DO NOTHING`)
    for (const email of [MAKER, CHECKER]) {
      owner(`INSERT INTO users (id, email, name, password_hash, status, updated_at) VALUES ('u-${email.split('@')[0]}-${code}', '${email}', '${email.split('@')[0]}', '${hash}', 'ACTIVE', now()) ON CONFLICT (email) DO NOTHING`)
      const id = owner(`SELECT id FROM users WHERE email = '${email}'`)
      owner(`INSERT INTO memberships (id, user_id, tenant_id, role, updated_at) VALUES ('m-${id}', '${id}', '${tenant}', 'owner', now()) ON CONFLICT DO NOTHING`)
      owner(`INSERT INTO "UserRole" (user_id, role_id, tenant_id) VALUES ('${id}', 'deal-role-${code}', '${tenant}') ON CONFLICT DO NOTHING`)
    }
    page = await as(browser, MAKER)
    checker = await as(browser, CHECKER)
  })

  test.afterAll(async () => {
    await page?.context().close(); await checker?.context().close()
    // The disposable database is dropped by the suite's teardown; nothing else needs undoing.
  })

  test('P1 the hotel tab shows the empty state and offers only what is supported; the form cannot activate', async () => {
    await page.goto(`${ORIGINS.admin}/hotels/${fixtures().hotelAlpha}?tab=rateplans&view=promotions`)
    await expect(page.getByRole('heading', { name: 'Hotel Deals & Promotions' })).toBeVisible()
    await expect(page.getByText('No promotions yet')).toBeVisible()
    await page.getByRole('link', { name: /create new promotion/i }).click()
    await expect(page).toHaveURL(/\/commercial\/promotions\/new\?hotelId=/)
    await expect(page.getByRole('heading', { name: 'Promotion type' })).toBeVisible()
    // Package add-on is not priceable on the existing model: shown as unavailable, never selectable.
    await expect(page.getByTestId('unsupported-kind')).toContainText('Package add-on')
    await expect(page.getByTestId('unsupported-kind')).toContainText('NOT AVAILABLE')
    await expect(page.getByRole('radio', { name: /package/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /activate/i })).toHaveCount(0)
    // Below-net override and platform funding do not exist.
    await expect(page.getByLabel('Funding source')).toHaveValue('Supplier funded')
    await expect(page.getByText(/no below-net override/i)).toBeVisible()
    // The API channel is not offered as a live channel.
    await expect(page.getByLabel(/distribution api/i)).toBeDisabled()
  })

  test('P2 problems are listed together, then a valid draft is saved and sells nothing', async () => {
    await page.getByRole('button', { name: 'Save draft' }).click()
    const problems = page.getByTestId('deal-problems')
    await expect(problems).toBeVisible()
    await expect(problems.getByRole('listitem')).not.toHaveCount(1)
    await page.getByLabel('Promotion code *').fill(code)
    await page.getByLabel('Promotion name *').fill(NAME)
    await page.getByLabel('Discount % *').fill('10')
    await page.getByTestId('deal-scope').getByRole('checkbox').first().check() // the room type selects all its plans
    await page.getByRole('button', { name: 'Save draft' }).click()
    await expect(page).toHaveURL(/\/commercial\/promotions\/[^/]+\?saved=1/)
    dealUrl = page.url().replace(/\?.*$/, '')
    await expect(page.getByRole('heading', { name: new RegExp(NAME) })).toBeVisible()
    await expect(page.getByTestId('deal-notice')).toContainText('Draft saved')
    await expect(page.getByText('DRAFT', { exact: true }).first()).toBeVisible()
    expect((await agentPrice())?.promotion).toBeUndefined()
  })

  test('P3 the maker validates and submits with a reason; the dialog traps focus and Escape cancels it', async () => {
    await page.getByRole('button', { name: 'Validate' }).click()
    await expect(page.getByTestId('deal-notice')).toContainText(/valid|finding/i)
    await page.getByRole('button', { name: 'Submit for approval' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Submit' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await page.getByRole('button', { name: 'Submit for approval' }).click()
    await dialog.getByLabel(/reason/i).fill('Ready for the revenue manager to review')
    await dialog.getByRole('button', { name: 'Submit' }).click()
    await expect(page.getByTestId('deal-notice')).toContainText('A different person must approve')
    await expect(page.getByText('PENDING APPROVAL').first()).toBeVisible()
    // The maker can withdraw but can not approve their own request, and the deal is locked.
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Withdraw request' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Edit draft' })).toHaveCount(0)
    expect((await agentPrice())?.promotion).toBeUndefined()
  })

  test('P4 a different person sees it in the queue and approves; approval alone does not put it on sale', async () => {
    await checker.goto(`${ORIGINS.admin}/commercial/promotions`)
    await checker.getByRole('tab', { name: 'Approval queue' }).click()
    const row = checker.getByRole('row', { name: new RegExp(NAME) })
    await expect(row).toBeVisible()
    await expect(row).toContainText('10% off every eligible night')
    await expect(row).toContainText('NO FINDINGS')
    await row.getByRole('button', { name: 'Approve' }).click()
    await checker.getByRole('dialog').getByLabel(/reason/i).fill('Terms checked against the contract')
    await checker.getByRole('dialog').getByRole('button', { name: 'Approve' }).click()
    await expect(checker.getByText(/approved\. it sells nothing until someone activates it/i)).toBeVisible()
    expect((await agentPrice())?.promotion).toBeUndefined()
  })

  test('P5 activation is a separate confirmed step and the deal then prices Agent search', async () => {
    const before = await agentPrice()
    await checker.getByRole('row', { name: new RegExp(NAME) }).getByRole('button', { name: 'Activate' }).click()
    await expect(checker.getByRole('dialog')).toContainText(/makes agents see the discounted price/i) // the consequence is stated before confirming
    await checker.getByRole('dialog').getByRole('button', { name: 'Activate' }).click()
    await expect(checker.getByText(/is activated\. search and recheck now price with it/i)).toBeVisible()
    const after = await agentPrice()
    expect(after?.promotion?.name).toBe(NAME)
    // The preview hotel sells 45 000 minor units a night; ten percent off, whatever the stay length.
    expect(after!.total).toBe(Math.round(before!.total * 0.9))
  })

  test('P6 the details page shows the approval, the audit trail and honest operations data', async () => {
    await checker.goto(dealUrl)
    await expect(checker.getByText('ACTIVE', { exact: true }).first()).toBeVisible()
    await checker.getByRole('tab', { name: 'Approval and audit history' }).click()
    for (const action of ['promotion.deal.created', 'promotion.deal.submitted', 'promotion.deal.approved', 'promotion.deal.activated']) await expect(checker.getByText(action, { exact: true })).toBeVisible()
    await checker.getByRole('tab', { name: 'Performance and operations' }).click()
    await expect(checker.getByText('NOT AVAILABLE').first()).toBeVisible() // redemptions and revenue are never invented
    await expect(checker.getByText(/booking is not enabled/i)).toBeVisible()
    await expect(checker.getByText('API: NOT PUBLISHED')).toBeVisible()
  })

  test('P7 the simulator prices from the real rates and writes nothing', async () => {
    await checker.goto(dealUrl)
    await checker.getByRole('tab', { name: 'Simulator' }).click()
    const stay = SELLABLE_STAY()
    await checker.getByLabel('Check-in *').fill(stay.checkIn)
    await checker.getByLabel('Nights').fill('2')
    await checker.getByRole('button', { name: 'Run preview' }).click()
    const result = checker.getByTestId('deal-preview-result')
    await expect(result).toContainText('DEAL APPLIES')
    await expect(result).toContainText('AED 900.00') // two nights at 450.00 without the deal
    await expect(result).toContainText('AED 810.00') // with ten percent off
    await expect(result).toContainText('AED 90.00') // the saving
    await expect(result).toContainText('Writes: none')
  })

  test('P8 a read-only admin sees the promotion and the list but no create or change controls; a user without supply access sees nothing', async ({ browser }) => {
    const reader = await as(browser, ACCOUNTS.admin)
    try {
      await reader.goto(dealUrl)
      await expect(reader.getByText('You can view this promotion but not change it.')).toBeVisible()
      await expect(reader.getByRole('button', { name: /pause|suspend|activate|approve/i })).toHaveCount(0)
      await reader.goto(`${ORIGINS.admin}/commercial/promotions`)
      await expect(reader.getByRole('link', { name: /create new promotion/i })).toHaveCount(0)
      await reader.goto(`${ORIGINS.admin}/commercial/promotions/new`)
      await expect(reader.getByText('You cannot create promotions.')).toBeVisible()
    } finally { await reader.context().close() }
    const restricted = await as(browser, ACCOUNTS.restricted, 'restricted')
    try {
      await restricted.goto(`${ORIGINS.admin}/commercial/promotions`)
      await expect(restricted.getByText(/You do not have permission to view this page/)).toBeVisible()
      await expect(restricted.getByText(NAME)).toHaveCount(0)
    } finally { await restricted.context().close() }
  })

  test('P9 pausing is a confirmed step with a reason and the price returns to the base rate at once', async () => {
    await checker.goto(dealUrl)
    await checker.getByRole('button', { name: 'Pause' }).click()
    await expect(checker.getByRole('dialog').getByRole('button', { name: 'Pause' })).toBeDisabled()
    await checker.getByRole('dialog').getByLabel(/reason/i).fill('Hold while the revenue team reviews the season')
    await checker.getByRole('dialog').getByRole('button', { name: 'Pause' }).click()
    await expect(checker.getByText(/paused\. agents see the base price again/i)).toBeVisible()
    expect((await agentPrice())?.promotion).toBeUndefined()
    await checker.getByRole('button', { name: 'Resume' }).click()
    await expect(checker.getByText('Resumed.')).toBeVisible()
    expect((await agentPrice())?.promotion?.name).toBe(NAME)
  })

  test('P10 suspending stops sales and offers no way back except a new, re-approved version', async () => {
    await checker.goto(dealUrl)
    await checker.getByRole('button', { name: 'Suspend' }).click()
    await checker.getByRole('dialog').getByLabel(/reason/i).fill('Integrity check failed on the contract rate')
    await checker.getByRole('dialog').getByRole('button', { name: 'Suspend' }).click()
    await expect(checker.getByText(/suspended\. it cannot resume/i)).toBeVisible()
    expect((await agentPrice())?.promotion).toBeUndefined()
    await expect(checker.getByRole('button', { name: 'Resume' })).toHaveCount(0)
    await expect(checker.getByRole('button', { name: 'Return to draft' })).toBeVisible()
  })

  test('P11 the list and the hotel tab agree: nothing is active, and the counts come from the API', async () => {
    await page.goto(`${ORIGINS.admin}/hotels/${fixtures().hotelAlpha}?tab=rateplans&view=promotions`)
    await expect(page.getByRole('link', { name: /Deals & Promos \(0\)/ })).toBeVisible()
    await expect(page.getByTestId('deal-tile-SUSPENDED')).toContainText('1')
    await expect(page.getByTestId('deal-tile-ACTIVE')).toContainText('0')
    await expect(page.getByRole('row', { name: new RegExp(NAME) })).toContainText('SUSPENDED')
  })
})
