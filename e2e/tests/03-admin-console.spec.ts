import { expect, test } from '@playwright/test'
import { ORIGINS } from '../support/config'
import { signInAdmin } from '../support/helpers'

test.describe('Admin console: tenant-scoped supply management', () => {
  test('D1 anonymous visitors are sent to sign-in and the page they wanted is remembered', async ({ page }) => {
    await page.goto(`${ORIGINS.admin}/hotels`)
    await expect(page).toHaveURL(/\/login\?from=%2Fhotels/)
    await expect(page.getByText('Sign in to your workspace')).toBeVisible()
  })

  test('D2 wrong password is refused with a generic message', async ({ page }) => {
    await page.goto(`${ORIGINS.admin}/login`)
    await page.getByLabel('Work email').fill('preview-admin@example.test')
    await page.getByLabel('Password').fill('not-the-password-123')
    await page.getByRole('button', { name: /sign in securely/i }).click()
    await expect(page.getByText('Invalid email or password.')).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
  })

  test('D3 an admin sees the dashboard, and the session cookie is HttpOnly + Secure', async ({ page, context }) => {
    await signInAdmin(page)
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByText('OPERATIONAL OVERVIEW')).toBeVisible()
    await expect(page.getByText('Preview Tenant A').first()).toBeVisible()
    const session = (await context.cookies(ORIGINS.admin)).find((c) => c.name === 'fbeds_session')!
    expect(session.httpOnly).toBe(true)
    expect(session.secure).toBe(true)
  })

  test('D4 the hotel directory lists this tenant’s hotels and none of another tenant’s', async ({ page }) => {
    await signInAdmin(page)
    await page.goto(`${ORIGINS.admin}/hotels`)
    await expect(page.getByText('Preview Creek Dubai').first()).toBeVisible()
    await expect(page.getByText('Preview Marina Dubai').first()).toBeVisible()
    await expect(page.getByText('Preview Other Tenant Dubai')).toHaveCount(0)
    await expect(page.getByText('2 Total hotels').or(page.getByText('Total hotels')).first()).toBeVisible()
  })

  test('D5 the supplier register shows only this tenant’s suppliers', async ({ page }) => {
    await signInAdmin(page)
    await page.goto(`${ORIGINS.admin}/suppliers`)
    await expect(page.getByText('Preview Supplier Alpha').first()).toBeVisible()
    await expect(page.getByText('Preview Supplier Beta').first()).toBeVisible()
    await expect(page.getByText(/2 results/)).toBeVisible()
  })

  test('D6 a signed-in admin without permission is told so, and no data is shown', async ({ page }) => {
    await signInAdmin(page, 'restricted')
    await expect(page.getByText('Access restricted')).toBeVisible()
    await expect(page.getByText('dashboard.read')).toBeVisible()
    await page.goto(`${ORIGINS.admin}/hotels`)
    await expect(page.getByText('Not permitted')).toBeVisible()
    await expect(page.getByText('Preview Creek Dubai')).toHaveCount(0)
    await page.goto(`${ORIGINS.admin}/suppliers`)
    await expect(page.getByText('No fallback data is shown.')).toBeVisible()
    await expect(page.getByText('Preview Supplier Alpha')).toHaveCount(0)
  })
})
