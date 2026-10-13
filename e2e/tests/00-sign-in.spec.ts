import { expect, test } from '@playwright/test'
import { PASSWORD, readState } from '../support/seed'

test.describe('sign in', () => {
  test('a visitor without a session is sent to the sign-in page', async ({ page }) => {
    await page.goto('/rates/plans/new')
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible()
  })

  test('a wrong password is refused with a message and no session', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Work email').fill(readState().operator)
    await page.getByLabel('Password').fill('not-the-password')
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })

  test('the right credentials open the console', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Work email').fill(readState().operator)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).not.toHaveURL(/\/login/)
  })
})
