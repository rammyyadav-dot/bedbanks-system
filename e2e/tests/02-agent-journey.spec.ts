import { expect, test } from '@playwright/test'
import { ORIGINS } from '../support/config'
import { isoDay, signInAgent } from '../support/helpers'

const D = (n: number) => isoDay(n)

test.describe('Agent portal: search, compare, recheck, booking stays closed', () => {
  test('A1 anonymous visitors see the sign-in page, not the workspace', async ({ page }) => {
    await page.goto(`${ORIGINS.agent}/login`)
    await expect(page.getByRole('button', { name: /agent sign in/i })).toBeVisible()
    await expect(page.getByText('Search hotel inventory')).toHaveCount(0)
  })

  test('A2 a wrong password shows an error and no workspace', async ({ page }) => {
    await page.goto(`${ORIGINS.agent}/login`)
    await page.locator('input[type=email]').fill('preview-agent@example.test')
    await page.locator('input[type=password]').fill('not-the-password-123')
    await page.getByRole('button', { name: /agent sign in/i }).click()
    await expect(page.getByText(/invalid|incorrect|could not/i).first()).toBeVisible()
    await expect(page.getByText('Search hotel inventory')).toHaveCount(0)
  })

  test('A3 Dubai search returns AED prices; recheck confirms the offer; booking is unavailable; sign-out ends the session', async ({ page, context }) => {
    await signInAgent(page)
    const cookies = await context.cookies(ORIGINS.agent)
    const session = cookies.find((c) => c.name === 'fbeds_session')!
    expect(session.httpOnly).toBe(true)
    expect(session.secure).toBe(true)

    // Pick destination.
    const destination = page.getByPlaceholder('Search destinations & hotels…')
    await destination.click()
    await destination.fill('Dubai')
    await page.getByRole('option', { name: /^Dubai City/ }).click()

    // Pick dates 14 and 16 days from now (the window the fixtures sell).
    await page.getByRole('button', { name: /nights/ }).first().click()
    // A day can appear twice (the trailing cell of one month and its own month); only the enabled one is selectable.
    await page.getByRole('button', { name: D(14), exact: true }).and(page.locator(':enabled')).first().click()
    await page.getByRole('button', { name: D(16), exact: true }).and(page.locator(':enabled')).first().click()
    await page.getByRole('button', { name: 'Apply dates' }).click()

    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByText('Preview Creek Dubai').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Preview Marina Dubai').first()).toBeVisible()
    await expect(page.getByText('Preview Other Tenant Dubai')).toHaveCount(0)
    await expect(page.getByText(/AED/).first()).toBeVisible()
    await expect(page.getByText(/not a supplier outage|No hotels matched/i)).toHaveCount(0)
    await expect(page.getByText('AED 900.00').first()).toBeVisible() // 2 nights x AED 450.00, integer minor units 90000

    // Compare, then authoritative recheck of the selected offer.
    await page.getByRole('button', { name: 'View rooms' }).first().click()
    await page.getByRole('button', { name: 'Select Offer' }).first().click()
    await expect(page.getByText('Offer rechecked')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Rechecked total')).toBeVisible()
    await expect(page.getByText(/Booking is not enabled for this workspace/)).toBeVisible()
    await expect(page.getByText(/creates no booking, hold or payment/)).toBeVisible()
    // Fail closed: nothing on the page lets the agent book or hold.
    await expect(page.getByRole('button', { name: /book now|confirm booking|hold|pay/i })).toHaveCount(0)

    // Sign out ends the server session.
    await page.getByText('Preview Agent', { exact: true }).click() // opens the profile menu
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('button', { name: /agent sign in/i })).toBeVisible()
    const after = await fetch(`${ORIGINS.api}/api/v1/agent/context`, { headers: { cookie: `fbeds_session=${session.value}` } })
    expect(after.status).toBe(401)
  })
})
