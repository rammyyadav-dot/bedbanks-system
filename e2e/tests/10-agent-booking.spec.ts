import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { DATABASE, ORIGINS, pgAdminUrl, urlFor } from '../support/config'
import { isoDay, signInAgent } from '../support/helpers'
import { moneyAndBookingCounts } from '../support/stack'

/**
 * Opt-in browser booking on the disposable preview database.
 * The release suite keeps BOOKING_ENABLED false. This file runs only when that flag is true
 * (`pnpm --filter @bedbanks/e2e e2e:booking`), which starts the API with booking turned on.
 * It never touches a database other than fbeds_preview_xt.
 */
const ENABLED = process.env.E2E_BOOKING_ENABLED === 'true'
const D = (n: number) => isoDay(n)
const SHOT = '/opt/cursor/artifacts/agent-booking-confirmed.png'

function ownerSql(sql: string): string {
  const admin = pgAdminUrl()
  const url = urlFor(admin, DATABASE, admin.username, decodeURIComponent(admin.password)).replace(/\?.*$/, '')
  const run = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`preview SQL failed: ${(run.stderr || run.stdout).slice(0, 400)}`)
  return run.stdout.trim()
}

/** The preview agent can search and book, but fixtures leave them outside any agency, so a hold would be refused for lack of credit. */
function linkPreviewAgency(): void {
  ownerSql(`
    INSERT INTO "Agency" (id, tenant_id, code, name, country_code, status, created_by_id, created_at, updated_at)
    SELECT 'e2e-preview-agency', t.id, 'PREVIEW-AGENCY', 'Preview Agency', 'AE', 'ACTIVE', u.id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM tenants t
    JOIN users u ON u.email = 'preview-admin@example.test'
    WHERE t.slug = 'preview-tenant-a'
    ON CONFLICT (tenant_id, code) DO NOTHING;
    INSERT INTO "AgencyMember" (agency_id, tenant_id, user_id, created_at)
    SELECT a.id, a.tenant_id, u.id, CURRENT_TIMESTAMP
    FROM "Agency" a
    JOIN users u ON u.email = 'preview-agent@example.test'
    WHERE a.id = 'e2e-preview-agency'
    ON CONFLICT (tenant_id, user_id) DO NOTHING;
    INSERT INTO "AgencyCreditLimit" (id, tenant_id, agency_id, currency, limit_minor, updated_by_id, created_at, updated_at)
    SELECT 'e2e-preview-credit', a.tenant_id, a.id, 'AED', 10000000, a.created_by_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM "Agency" a
    WHERE a.id = 'e2e-preview-agency'
    ON CONFLICT (agency_id) DO UPDATE SET currency = EXCLUDED.currency, limit_minor = EXCLUDED.limit_minor, updated_at = CURRENT_TIMESTAMP;
  `)
}

async function searchDubai(page: Page): Promise<void> {
  const destination = page.getByPlaceholder('Search destinations & hotels…')
  await destination.click()
  await destination.fill('Dubai')
  await page.getByRole('option', { name: /^Dubai City/ }).click()
  await page.getByRole('button', { name: /nights/ }).first().click()
  await page.getByRole('button', { name: D(14), exact: true }).and(page.locator(':enabled')).first().click()
  await page.getByRole('button', { name: D(16), exact: true }).and(page.locator(':enabled')).first().click()
  await page.getByRole('button', { name: 'Apply dates' }).click()
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByText('Preview Creek Dubai').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Preview Marina Dubai').first()).toBeVisible()
  await expect(page.getByText('Preview Other Tenant Dubai')).toHaveCount(0)
  await expect(page.getByText('AED 900.00').first()).toBeVisible()
}

test.describe('Agent portal booking', () => {
  test.skip(!ENABLED, 'set E2E_BOOKING_ENABLED=true (pnpm --filter @bedbanks/e2e e2e:booking)')

  test('BK1 search, recheck, hold, and confirm a contracted Dubai stay on agency credit', async ({ page }) => {
    test.setTimeout(120_000)
    linkPreviewAgency()
    const before = moneyAndBookingCounts()
    expect(before.Booking).toBe(0)
    expect(before.InventoryHold).toBe(0)
    expect(before.LedgerEntry).toBe(0)

    await signInAgent(page)
    await searchDubai(page)
    await page.getByRole('button', { name: 'View rooms' }).first().click()
    await page.getByRole('button', { name: 'Select Offer' }).first().click()
    await expect(page.getByRole('heading', { name: 'Booking review' })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/Booking is not enabled for this workspace/)).toHaveCount(0)

    await page.getByRole('button', { name: /Hold this rate · AED 900\.00/ }).click()
    await expect(page.getByLabel('Room 1 adult first name').first()).toBeVisible({ timeout: 20_000 })

    const first = page.getByLabel('Room 1 adult first name')
    const last = page.getByLabel('Room 1 adult last name')
    await first.nth(0).fill('Amira')
    await last.nth(0).fill('Hassan')
    await first.nth(1).fill('Yusuf')
    await last.nth(1).fill('Hassan')
    await page.getByLabel('Agent reference (optional)').fill('E2E-FILE-1')
    await page.getByRole('checkbox', { name: /I accept the cancellation policy/ }).check()
    await page.getByRole('button', { name: /Confirm & book · AED 900\.00/ }).click()

    const confirmed = page.getByRole('status', { name: 'Booking confirmed' })
    await expect(confirmed).toBeVisible({ timeout: 30_000 })
    await expect(confirmed).toContainText(/Reference FB-[0-9A-F]{20}/)
    await expect(confirmed).toContainText('your ref E2E-FILE-1')
    await expect(confirmed).toContainText('AED 900.00')
    await expect(confirmed).toContainText('agency credit')
    await expect(confirmed.getByText('Preview Other Tenant Dubai')).toHaveCount(0)
    await expect(page.getByText(/Outcome unknown|Booking not completed/)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Voucher/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Invoice/ })).toBeVisible()

    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    await confirmed.screenshot({ path: SHOT })

    const booking = ownerSql(`SELECT status || '|' || currency || '|' || total_minor::text || '|' || supplier || '|' || COALESCE(agent_ref, '') FROM "Booking"`)
    expect(booking).toBe('CONFIRMED|AED|90000|contracted-inventory|E2E-FILE-1')
    expect(ownerSql(`SELECT status FROM "InventoryHold"`)).toBe('CONFIRMED')
    expect(ownerSql(`SELECT type || '|' || amount_minor::text FROM "LedgerEntry" ORDER BY type`)).toBe('DEBIT|-90000\nHOLD|-90000\nRELEASE|90000')
    expect(ownerSql(`SELECT COALESCE(sum(sold), 0)::text || '|' || COALESCE(sum(held), 0)::text FROM "DailyAvailability"`)).toBe('2|0')
    expect(ownerSql(`SELECT count(*)::text FROM "Booking" b JOIN tenants t ON t.id = b.tenant_id WHERE t.slug <> 'preview-tenant-a'`)).toBe('0')
    const after = moneyAndBookingCounts()
    expect(after.Booking).toBe(1)
    expect(after.BookingGuest).toBe(2)
    expect(after.InventoryHold).toBe(1)
    expect(after.InventoryHoldNight).toBe(2)
    expect(after.LedgerEntry).toBe(3)
    await expect(confirmed).toContainText(/Preview (Creek|Marina) Dubai/)
  })
})
