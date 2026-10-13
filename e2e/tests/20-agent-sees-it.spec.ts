import { expect, test, type Page } from '@playwright/test'
import { PASSWORD, day, readState } from '../support/seed'
import { withDb } from '../support/session'

const AGENT = `http://localhost:${process.env.E2E_AGENT_PORT ?? 3900}`

/**
 * The buyer's side of the same plan. After the Admin journey activated a derived plan with a promotion, an Agent searching Dubai in the Agent portal sees it
 * at the exact price the platform computes: parent rate, minus the derived adjustment, minus the promotion, THEN the margin. The numbers are worked out here
 * by hand, in integer minor units, not read back from the code under test.
 *
 *   parent net 50,000/night, margin 10%              -> parent sells 55,000/night, 3 nights = 165,000 (AED 1,650.00)
 *   derived  : 50,000 - 10% = 45,000 net
 *   promotion: long stay, 10% off the net: 45,000 - 4,500 = 40,500 net
 *   margin 10% of 40,500 = 4,050                       -> derived sells 44,550/night, 3 nights = 133,650 (AED 1,336.50)
 */
async function signInAsAgent(page: Page, email: string) {
  await page.goto(`${AGENT}/login`)
  await page.getByLabel('Work email').fill(email)
  await page.locator('#password').fill(PASSWORD)
  await page.getByRole('button', { name: /agent sign in/i }).click()
  await expect(page.getByRole('button', { name: 'Search Hotels' })).toBeVisible()
}

/** A stay starting today is already past the plan's release cutoff in the hotel's own time, so the buyer picks later dates, as a real agent would. */
async function searchDubai(page: Page) {
  await page.getByPlaceholder('Select a city or hotel').fill('Dubai')
  await page.getByRole('option', { name: /Dubai/ }).first().click()
  await page.getByRole('button', { name: /nights/ }).click()
  await page.getByRole('button', { name: day(3), exact: true }).click()
  await page.getByRole('button', { name: day(6), exact: true }).click()
  await page.getByRole('button', { name: 'Apply dates' }).click()
  await page.getByRole('button', { name: 'Search Hotels' }).click()
}

test.describe.serial('what the Agent sees', () => {
  const state = readState()

  test('the activated derived plan is sold at the exact computed price, with its promotion named', async ({ page }) => {
    await signInAsAgent(page, state.agent)
    await searchDubai(page)
    const hotel = page.getByLabel('Hotel results')
    await expect(hotel.getByText(state.hotelName)).toBeVisible()
    await hotel.getByRole('button', { name: `View rooms for ${state.hotelName}` }).click()
    const derived = page.locator('.market-rate-row').filter({ hasText: `GUIDED-${state.suffix}`.toUpperCase() })
    await expect(derived).toContainText('1,336.50')
    await expect(derived).toContainText('Stay 3 save 10 applied')
    const parent = page.locator('.market-rate-row').filter({ hasText: state.parentPlanCode })
    await expect(parent).toContainText('1,650.00')
    await expect(parent).not.toContainText('applied')
  })

  test('a plan that is not active is not on sale: suspending it removes it from the Agent search', async ({ page }) => {
    await withDb((db) => db.ratePlan.updateMany({ where: { code: `GUIDED-${state.suffix}`.toUpperCase() }, data: { status: 'SUSPENDED' } }))
    await signInAsAgent(page, state.agent)
    await searchDubai(page)
    await page.getByLabel('Hotel results').getByRole('button', { name: `View rooms for ${state.hotelName}` }).click()
    await expect(page.locator('.market-rate-row').filter({ hasText: state.parentPlanCode })).toBeVisible()
    await expect(page.locator('.market-rate-row').filter({ hasText: `GUIDED-${state.suffix}`.toUpperCase() })).toHaveCount(0)
  })
})
